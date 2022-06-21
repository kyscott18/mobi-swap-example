import { ChainId, Multicall } from "@dahlia-labs/celo-contrib";
import { StablePools } from "@dahlia-labs/mobius-config-registry";
import type { IExchangeInfo } from "@dahlia-labs/stableswap-sdk";
import {
  calculateEstimatedSwapOutputAmount,
  calculateSwapPrice,
} from "@dahlia-labs/stableswap-sdk";
import { Percent, TokenAmount } from "@dahlia-labs/token-utils";
import type { Interface, Result } from "@ethersproject/abi";
import { getAddress } from "@ethersproject/address";
import { AddressZero } from "@ethersproject/constants";
import type { ContractInterface } from "@ethersproject/contracts";
import { Contract } from "@ethersproject/contracts";
import type { JsonRpcProvider } from "@ethersproject/providers";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import type { BigNumber } from "ethers";
import JSBI from "jsbi";
import { chunk } from "lodash";
import invariant from "tiny-invariant";

import LP_ABI from "./abis/LPToken.json";
import MULTICALL_ABI from "./abis/multicall2.json";
import SWAP_ABI from "./abis/Swap.json";
import type { LPToken, Multicall2, Swap } from "./generated";

const MAX_CHUNK = 100;
interface Call {
  target: string;
  callData: string;
}

// returns the checksummed address if the address is valid, otherwise returns false
function isAddress(value: string): string | false {
  try {
    return getAddress(value);
  } catch {
    return false;
  }
}

const parseFunctionReturn = (
  _interface: Interface,
  func: string,
  returnData: string | undefined | unknown
): Result => {
  invariant(typeof returnData === "string", "return data not found");
  return _interface.decodeFunctionResult(func, returnData);
};

function getContract(
  address: string,
  ABI: ContractInterface,
  provider: JsonRpcProvider
): Contract {
  if (!isAddress(address)) {
    throw Error(`Invalid 'address' parameter '${address}'.`);
  }
  return new Contract(address, ABI, provider);
}

function useContract(
  address: string | undefined,
  ABI: ContractInterface,
  provider: JsonRpcProvider
): Contract | null {
  if (!address || !ABI) return null;
  try {
    return getContract(address, ABI, provider);
  } catch (error) {
    console.error("Failed to get contract", error);
    return null;
  }
}

function useSwapContract(
  address: string,
  provider: JsonRpcProvider
): Swap | null {
  return useContract(address, SWAP_ABI.abi, provider) as Swap | null;
}

const FEE_BASE = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(10));

function useLPContract(
  address: string,
  provider: JsonRpcProvider
): LPToken | null {
  return useContract(address, LP_ABI.abi, provider) as LPToken | null;
}

// Multicall allows for simultaneous requests, speeding up fetches
function useMulticall(provider: JsonRpcProvider): Multicall2 | null {
  return useContract(
    Multicall[ChainId.Mainnet],
    MULTICALL_ABI,
    provider
  ) as Multicall2 | null;
}

const fetchAllPrices = async (): Promise<void> => {
  const provider = new StaticJsonRpcProvider("https://forno.celo.org");

  const mobiusPools = StablePools[ChainId.Mainnet];

  const multicall = useMulticall(provider);
  const swapContract = useSwapContract(AddressZero, provider);
  const lpContract = useLPContract(AddressZero, provider);

  invariant(multicall && swapContract && lpContract);

  // formats calls into chunks
  const getMulticallDataChunked = async (calls: Call[]) => {
    const callChunks = chunk(calls, MAX_CHUNK);
    return (
      await Promise.all(
        callChunks.map((c) => multicall.callStatic.aggregate(c))
      )
    ).flatMap((c) => c.returnData);
  };

  // Make contract calls for each pool
  const calls: Call[] = StablePools[ChainId.Mainnet].flatMap((p) => [
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("getA"),
    },
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("swapStorage"),
    },
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("paused"),
    },
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("getBalances"),
    },
    {
      target: p.pool.lpToken.address,
      callData: lpContract.interface.encodeFunctionData("totalSupply"),
    },
  ]);

  const poolData = await getMulticallDataChunked(calls);

  interface Swap {
    swapFee: BigNumber;
    adminFee: BigNumber;
    defaultDepositFee: BigNumber;
    defaultWithdrawFee: BigNumber;
  }

  chunk(poolData, 5).forEach((pd, i) => {
    const pool = mobiusPools[i];
    invariant(pool);

    const amp = parseFunctionReturn(swapContract.interface, "getA", pd[0]);
    const swap = parseFunctionReturn(
      swapContract.interface,
      "swapStorage",
      pd[1]
    ) as unknown as Swap;
    const paused = parseFunctionReturn(
      swapContract.interface,
      "paused",
      pd[2]
    ) as [boolean];

    const balances = parseFunctionReturn(
      swapContract.interface,
      "getBalances",
      pd[3]
    ) as [[BigNumber, BigNumber]];

    const totalSupply = new TokenAmount(
      pool.pool.lpToken,
      parseFunctionReturn(lpContract.interface, "totalSupply", pd[4]).toString()
    );

    const exchangeInfo: IExchangeInfo = {
      ampFactor: JSBI.BigInt(amp.toString()),
      paused: paused[0] === true,
      fees: {
        trade: new Percent(swap.swapFee.toString(), FEE_BASE),
        admin: new Percent(swap.adminFee.toString(), FEE_BASE),
        deposit: new Percent(swap.defaultDepositFee.toString(), FEE_BASE),
        withdraw: new Percent(swap.defaultWithdrawFee.toString(), FEE_BASE),
      },
      lpTotalSupply: totalSupply,
      reserves: [
        new TokenAmount(pool.pool.tokens[0], balances[0][0].toString()),
        new TokenAmount(pool.pool.tokens[1], balances[0][1].toString()),
      ],
    };

    const swapPrice = calculateSwapPrice(exchangeInfo).asFraction;

    const testAmount = TokenAmount.parse(pool.pool.tokens[1], "10000");
    const testOutput = calculateEstimatedSwapOutputAmount(
      exchangeInfo,
      testAmount
    );

    console.log(
      `${pool.name} pool has price ${swapPrice.toSignificant(4)} ${
        pool.pool.tokens[1].symbol
      } per ${pool.pool.tokens[0].symbol} | 10,000 ${
        pool.pool.tokens[1].symbol
      } -> ${testOutput.outputAmount.toSignificant(4, {
        groupSeparator: ",",
      })} ${pool.pool.tokens[0].symbol}`
    );
  });
};

fetchAllPrices().catch((err) => {
  console.error(err);
});
