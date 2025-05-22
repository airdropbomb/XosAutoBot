import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL_XOS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WXOS_ADDRESS = process.env.WXOS_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS;
const BNB_ADDRESS = process.env.BNB_ADDRESS;
const JUP_ADDRESS = process.env.JUP_ADDRESS;
const SOL_ADDRESS = process.env.SOL_ADDRESS;
const SWAP_ROUTER_ADDRESS = "0xdc7D6b58c89A554b3FDC4B5B10De9b4DbF39FB40";
const NETWORK_NAME = "XOS TESTNET";
const DEBUG_MODE = false;

const ERC20ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const WXOS_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) returns (uint256)"
];

const randomAmountRanges = {
  "XOS_WXOS": { XOS: { min: 0.005, max: 0.01 }, WXOS: { min: 0.005, max: 0.01 } },
  "XOS_USDC": { XOS: { min: 0.005, max: 0.01 }, USDC: { min: 0.2, max: 0.45 } },
  "XOS_BNB": { XOS: { min: 0.005, max: 0.01 }, BNB: { min: 0.0003, max: 0.00075 } },
  "XOS_SOL": { XOS: { min: 0.005, max: 0.01 }, SOL: { min: 0.0015, max: 0.003 } },
  "XOS_JUP": { XOS: { min: 0.005, max: 0.01 }, JUP: { min: 0.12, max: 0.25 } }
};

let walletInfo = {
  address: "",
  balanceXos: "0.00",
  balanceWxos: "0.00",
  balanceUsdc: "0.00",
  balanceBnb: "0.00",
  balanceJup: "0.00",
  balanceSol: "0.00",
  network拱: NETWORK_NAME,
  status: "Initializing"
};

let transactionLogs = [];
let swapRunning = false;
let swapCancelled = false;
let globalWallet = null;
let provider = null;
let transactionQueue = Promise.resolve();
let transactionIdCounter = 0;
let nextNonce = null;
let lastSwapDirectionXosWxos = null;
let lastSwapDirectionXosUsdc = null;
let lastSwapDirectionXosBnb = null;
let lastSwapDirectionXosSol = null;
let lastSwapDirectionXosJup = null;

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortHash(hash) {
  return hash && typeof hash === "string" && hash !== "0x" ? hash.slice(0, 6) + "..." + hash.slice(-4) : "Invalid Hash";
}

function addLog(message, type) {
  if (type === "debug" && !DEBUG_MODE) return;
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage = message;
  if (type === "swap") coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  else if (type === "system") coloredMessage = `{bright-white-fg}${message}{/bright-white-fg}`;
  else if (type === "error") coloredMessage = `{bright-red-fg}${message}{/bright-red-fg}`;
  else if (type === "success") coloredMessage = `{bright-green-fg}${message}{/bright-green-fg}`;
  else if (type === "warning") coloredMessage = `{bright-yellow-fg}${message}{/bright-yellow-fg}`;
  else if (type === "debug") coloredMessage = `{bright-magenta-fg}${message}{/bright-magenta-fg}`;

  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function getRandomDelay() {
  return Math.random() * (60000 - 30000) + 30000;
}

function getRandomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.setScrollPerc(100);
  safeRender();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logsBox.setContent("");
  logsBox.setScroll(0);
  updateLogs();
  safeRender();
  addLog("Transaction logs have been cleared.", "system");
}

function convertBigIntToString(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));
}

async function waitWithCancel(delay, type) {
  return Promise.race([
    new Promise(resolve => setTimeout(resolve, delay)),
    new Promise(resolve => {
      const interval = setInterval(() => {
        if (type === "swap" && swapCancelled) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    })
  ]);
}

async function addTransactionToQueue(transactionFunction, description = "Transaction") {
  const transactionId = ++transactionIdCounter;
  transactionLogs.push(`Transaction [${transactionId}] added to queue: ${description}`);
  updateLogs();

  transactionQueue = transactionQueue.then(async () => {
    try {
      if (nextNonce === null) {
        nextNonce = await provider.getTransactionCount(globalWallet.address, "pending");
        addLog(`Initial nonce: ${nextNonce}`, "debug");
      }
      const tx = await transactionFunction(nextNonce);
      const txHash = tx.hash;
      const receipt = await tx.wait();
      nextNonce++;
      if (receipt.status === 1) {
        addLog(`Transaction [${transactionId}] completed. Hash: ${getShortHash(receipt.transactionHash || txHash)}`, "success");
      } else {
        addLog(`Transaction [${transactionId}] failed: Transaction rejected by contract.`, "error");
      }
      return { receipt, txHash, tx };
    } catch (error) {
      let errorMessage = error.message;
      if (error.code === "CALL_EXCEPTION") {
        errorMessage = `Transaction rejected by contract: ${error.reason || "Unknown reason"}`;
      }
      addLog(`Transaction [${transactionId}] failed: ${errorMessage}`, "error");
      if (error.message.includes("nonce has already been used")) {
        nextNonce++;
        addLog(`Nonce incremented due to previous use. New nonce: ${nextNonce}`, "system");
      }
      return null;
    }
  });
  return transactionQueue;
}

async function getTokenBalance(tokenAddress) {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20ABI, provider);
    const balance = await contract.balanceOf(globalWallet.address);
    const decimals = await contract.decimals();
    return ethers.formatUnits(balance, decimals);
  } catch (error) {
    addLog(`Failed to fetch token balance ${tokenAddress}: ${error.message}`, "error");
    return "0";
  }
}

async function estimateGasPrice() {
  try {
    const gasPrice = await provider.getFeeData();
    return gasPrice.gasPrice || ethers.parseUnits("5", "gwei");
  } catch (error) {
    addLog(`Failed to fetch gas price: ${error.message}. Using default 5 gwei.`, "debug");
    return ethers.parseUnits("5", "gwei");
  }
}

async function estimateTransactionCost(gasLimit) {
  const gasPrice = await estimateGasPrice();
  return gasPrice * BigInt(gasLimit);
}

async function updateWalletData() {
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    globalWallet = wallet;
    walletInfo.address = wallet.address;

    const xosBalance = await provider.getBalance(wallet.address);
    walletInfo.balanceXos = ethers.formatEther(xosBalance);

    walletInfo.balanceWxos = await getTokenBalance(WXOS_ADDRESS);
    walletInfo.balanceUsdc = await getTokenBalance(USDC_ADDRESS);
    walletInfo.balanceBnb = await getTokenBalance(BNB_ADDRESS);
    walletInfo.balanceJup = await getTokenBalance(JUP_ADDRESS);
    walletInfo.balanceSol = await getTokenBalance(SOL_ADDRESS);
    updateWallet();
    addLog("Wallet information updated!", "system");
  } catch (error) {
    addLog("Failed to fetch wallet data: " + error.message, "system");
  }
}

function updateWallet() {
  const shortAddress = walletInfo.address ? getShortAddress(walletInfo.address) : "N/A";
  const xos = walletInfo.balanceXos ? Number(walletInfo.balanceXos).toFixed(4) : "0.0000";
  const wxos = walletInfo.balanceWxos ? Number(walletInfo.balanceWxos).toFixed(4) : "0.0000";
  const usdc = walletInfo.balanceUsdc ? Number(walletInfo.balanceUsdc).toFixed(2) : "0.00";
  const bnb = walletInfo.balanceBnb ? Number(walletInfo.balanceBnb).toFixed(5) : "0.0000";
  const jup = walletInfo.balanceJup ? Number(walletInfo.balanceJup).toFixed(4) : "0.0000";
  const sol = walletInfo.balanceSol ? Number(walletInfo.balanceSol).toFixed(4) : "0.00";

  const content = `┌── Address   : {bright-yellow-fg}${shortAddress}{/bright-yellow-fg}
│   ├── XOS       : {bright-green-fg}${xos}{/bright-green-fg}
│   ├── WXOS      : {bright-green-fg}${wxos}{/bright-green-fg}
│   ├── USDC      : {bright-green-fg}${usdc}{/bright-green-fg}
│   ├── BNB       : {bright-green-fg}${bnb}{/bright-green-fg}
│   ├── JUP       : {bright-green-fg}${jup}{/bright-green-fg}
│   ├── SOL       : {bright-green-fg}${sol}{/bright-green-fg}
└── Network       : {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`;
  walletBox.setContent(content);
  safeRender();
}

async function autoSwapXosWxos() {
  const direction = lastSwapDirectionXosWxos === "XOS_TO_WXOS" ? "WXOS_TO_XOS" : "XOS_TO_WXOS";
  lastSwapDirectionXosWxos = direction;

  const ranges = randomAmountRanges["XOS_WXOS"];
  const amount = direction === "XOS_TO_WXOS" 
    ? getRandomNumber(ranges.XOS.min, ranges.XOS.max).toFixed(6)
    : getRandomNumber(ranges.WXOS.min, ranges.WXOS.max).toFixed(6);
  const wxosContract = new ethers.Contract(WXOS_ADDRESS, WXOS_ABI, globalWallet);
  const decimals = await wxosContract.decimals();
  const amountWei = ethers.parseUnits(amount, decimals);

  if (direction === "XOS_TO_WXOS") {
    const xosBalance = await provider.getBalance(globalWallet.address);
    const estimatedGasCost = await estimateTransactionCost(80000);
    const totalRequired = ethers.parseEther(amount) + estimatedGasCost;
    if (xosBalance < totalRequired) {
      addLog(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)} (swap + gas)`, "warning");
      return false;
    }

    addLog(`Performing swap ${amount} XOS ➯ WXOS`, "swap");

    let txParams = { value: amountWei, nonce: null, gasLimit: 80000 };
    try {
      const gasLimit = await wxosContract.estimateGas.deposit({ value: amountWei });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Gas estimate: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed for deposit: ${error.message}. Using default gas 80000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await wxosContract.deposit(txParams);
      addLog(`Tx sent ${amount} XOS ➯ WXOS, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const result = await addTransactionToQueue(swapTxFunction, `Swap ${amount} XOS to WXOS`);

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(`Swap successful ${amount} XOS ➯ WXOS, Hash: ${getShortHash(result.receipt.transactionHash || result.txHash)}`, "success");
      return true;
    } else {
      addLog(`Failed to swap XOS to WXOS. Transaction may have failed or is pending.`, "error");
      return false;
    }
  } else {
    const wxosBalance = await getTokenBalance(WXOS_ADDRESS);
    if (parseFloat(wxosBalance) < parseFloat(amount)) {
      addLog(`Insufficient WXOS balance: ${wxosBalance} < ${amount}`, "warning");
      return false;
    }

    addLog(`Performing swap ${amount} WXOS ➯ XOS`, "swap");

    let txParams = { nonce: null, gasLimit: 80000 };
    try {
      const gasLimit = await wxosContract.estimateGas.withdraw(amountWei);
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Gas estimate: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed for withdraw: ${error.message}. Using default gas 80000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await wxosContract.withdraw(amountWei, txParams);
      addLog(`Tx sent ${amount} WXOS ➯ XOS, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const result = await addTransactionToQueue(swapTxFunction, `Swap ${amount} WXOS to XOS`);

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(`Swap successful ${amount} WXOS ➯ XOS, Hash: ${getShortHash(result.receipt.transactionHash || result.txHash)}`, "success");
      return true;
    } else {
      addLog(`Failed to swap WXOS to XOS. Transaction may have failed or is pending.`, "error");
      return false;
    }
  }
}

async function autoSwapXosUsdc() {
  const direction = lastSwapDirectionXosUsdc === "XOS_TO_USDC" ? "USDC_TO_XOS" : "XOS_TO_USDC";
  lastSwapDirectionXosUsdc = direction;

  const ranges = randomAmountRanges["XOS_USDC"];
  const amount = direction === "XOS_TO_USDC" 
    ? getRandomNumber(ranges.XOS.min, ranges.XOS.max).toFixed(6)
    : getRandomNumber(ranges.USDC.min, ranges.USDC.max).toFixed(6);

  const wxosContract = new ethers.Contract(WXOS_ADDRESS, WXOS_ABI, globalWallet);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20ABI, globalWallet);
  const swapRouterContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, globalWallet);
  const decimalsUsdc = await usdcContract.decimals();
  const amountWei = direction === "XOS_TO_USDC" 
    ? ethers.parseEther(amount) 
    : ethers.parseUnits(amount, decimalsUsdc);
  const fee = direction === "XOS_TO_USDC" ? 500 : 3000;
  const slippageTolerance = 0.005; 
  const xosPerUsdc = 46.6769;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  if (direction === "XOS_TO_USDC") {
    const xosBalance = await provider.getBalance(globalWallet.address);
    const estimatedGasCost = await estimateTransactionCost(150000);
    const totalRequired = ethers.parseEther(amount) + estimatedGasCost;
    if (xosBalance < totalRequired) {
      addLog(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)} (swap + gas)`, "warning");
      return false;
    }

    const expectedUsdc = (parseFloat(amount) / xosPerUsdc).toFixed(6);
    const minUsdc = (parseFloat(expectedUsdc) * (1 - slippageTolerance)).toFixed(6);
    const amountOutMinimum = ethers.parseUnits(minUsdc, decimalsUsdc);

    addLog(`Performing swap ${amount} XOS ➯ USDC, Expected output: ${expectedUsdc} USDC, Minimum: ${minUsdc} USDC`, "swap");

    const allowance = await wxosContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for WXOS`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 80000 };
      try {
        const approveGasLimit = await wxosContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Gas estimate for WXOS approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for WXOS approval: ${error.message}. Using default gas 80000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await wxosContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for WXOS`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve WXOS for ${amount} XOS`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for WXOS. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for WXOS`, "swap");
    }

    const swapParams = {
      tokenIn: WXOS_ADDRESS,
      tokenOut: USDC_ADDRESS,
      fee,
      recipient: globalWallet.address,
      amountIn: amountWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const multicallData = [encodedData];

    let txParams = { value: amountWei, nonce: null, gasLimit: 150000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData, { value: amountWei });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Gas estimate for swap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed for swap: ${error.message}. Using default gas 150000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} XOS ➯ USDC, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const result = await addTransactionToQueue(swapTxFunction, `Swap ${amount} XOS to USDC`);

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(`Swap successful ${amount} XOS ➯ USDC, Received: ${expectedUsdc} USDC, Hash: ${getShortHash(result.receipt.transactionHash || result.txHash)}`, "success");
      return true;
    } else {
      addLog(`Failed to swap XOS to USDC. Transaction may have failed or is pending.`, "error");
      return false;
    }
  } else {
    const usdcBalance = await getTokenBalance(USDC_ADDRESS);
    addLog(`USDC balance: ${usdcBalance}`, "debug");
    if (parseFloat(usdcBalance) < parseFloat(amount)) {
      addLog(`Insufficient USDC balance: ${usdcBalance} < ${amount}`, "warning");
      return false;
    }
  
    const expectedXos = (parseFloat(amount) * xosPerUsdc).toFixed(6);
    const minXos = (parseFloat(expectedXos) * (1 - slippageTolerance)).toFixed(6);
    addLog(`Expected XOS: ${expectedXos}, Min XOS (ref): ${minXos}`, "debug");
  
    const allowance = await usdcContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    addLog(`USDC allowance: ${ethers.formatUnits(allowance, decimalsUsdc)}`, "debug");
    if (allowance < amountWei) {
      addLog(`Requesting approval for ${amount} USDC`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 100000 };
      try {
        const approveGasLimit = await usdcContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(130)) / BigInt(100);
        addLog(`Gas estimate for USDC approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for USDC approval: ${error.message}. Using default gas 100000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await usdcContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for ${amount} USDC, Hash: ${getShortHash(tx.hash)}`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve ${amount} USDC`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for USDC. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for ${amount} USDC`, "swap");
    }
  
    const deadline = Math.floor(Date.now() / 1000) + 60 * 30; 
    const swapParams = {
      tokenIn: USDC_ADDRESS,
      tokenOut: WXOS_ADDRESS,
      fee: 500, 
      recipient: SWAP_ROUTER_ADDRESS, 
      amountIn: amountWei,
      amountOutMinimum: 0, 
      sqrtPriceLimitX96: 0
    };
    addLog(`Swap params USDC -> WXOS: ${JSON.stringify(convertBigIntToString(swapParams))}`, "debug");
  
    const unwrapParams = {
      amountMinimum: 0,
      recipient: globalWallet.address 
    };
    addLog(`Unwrap params WXOS -> XOS: ${JSON.stringify(convertBigIntToString(unwrapParams))}`, "debug");
  
    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedSwapData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const encodedUnwrapData = swapInterface.encodeFunctionData('unwrapWETH9', [unwrapParams.amountMinimum, unwrapParams.recipient]);
    const multicallData = [encodedSwapData, encodedUnwrapData];
  
    let txParams = { value: 0, nonce: null, gasLimit: 250000 }; 
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData);
      txParams.gasLimit = (gasLimit * BigInt(130)) / BigInt(100); 
      addLog(`Gas estimate for swap and unwrap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed: ${error.message}. Using default gas 400000.`, "debug");
    }
  
    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} USDC ➯ XOS (via WXOS), Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };
  
    const swapResult = await addTransactionToQueue(swapTxFunction, `Swap ${amount} USDC to XOS`);
    if (!swapResult || !swapResult.receipt || swapResult.receipt.status !== 1) {
      addLog(`Failed to swap USDC to XOS. Check logs for details.`, "error");
      return false;
    }
    addLog(`Swap successful ${amount} USDC ➯ XOS, Hash: ${getShortHash(swapResult.receipt.transactionHash || swapResult.txHash)}`, "success");
  
    const xosBalanceAfterSwap = ethers.formatEther(await provider.getBalance(globalWallet.address));
    addLog(`XOS balance after swap: ${xosBalanceAfterSwap}`, "debug");
    if (parseFloat(xosBalanceAfterSwap) <= 0) {
      addLog(`No XOS received after swap.`, "error");
      return false;
    }
  
    addLog(`Swap successful ${amount} USDC ➯ XOS, Received: ~${xosBalanceAfterSwap} XOS, Hash: ${getShortHash(swapResult.receipt.transactionHash || swapResult.txHash)}`, "success");
    return true;
  }
}

async function autoSwapXosBnb() {
  const direction = lastSwapDirectionXosBnb === "XOS_TO_BNB" ? "BNB_TO_XOS" : "XOS_TO_BNB";
  lastSwapDirectionXosBnb = direction;

  const ranges = randomAmountRanges["XOS_BNB"];
  const amount = direction === "XOS_TO_BNB" 
    ? getRandomNumber(ranges.XOS.min, ranges.XOS.max).toFixed(6)
    : getRandomNumber(ranges.BNB.min, ranges.BNB.max).toFixed(6);

  const wxosContract = new ethers.Contract(WXOS_ADDRESS, WXOS_ABI, globalWallet);
  const bnbContract = new ethers.Contract(BNB_ADDRESS, ERC20ABI, globalWallet);
  const swapRouterContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, globalWallet);
  const decimalsBnb = await bnbContract.decimals();
  const amountWei = direction === "XOS_TO_BNB" 
    ? ethers.parseEther(amount) 
    : ethers.parseUnits(amount, decimalsBnb);
  const fee = 500;
  const slippageTolerance = 0.005; 
  const xosPerBnb = 0.07779;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; 
  if (direction === "XOS_TO_BNB") {
    const xosBalance = await provider.getBalance(globalWallet.address);
    const estimatedGasCost = await estimateTransactionCost(150000);
    const totalRequired = ethers.parseEther(amount) + estimatedGasCost;
    if (xosBalance < totalRequired) {
      addLog(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)} (swap + gas)`, "warning");
      return false;
    }

    const expectedBnb = (parseFloat(amount) / xosPerBnb).toFixed(6);
    const minBnb = (parseFloat(expectedBnb) * (1 - slippageTolerance)).toFixed(6);
    const amountOutMinimum = ethers.parseUnits(minBnb, decimalsBnb);

    addLog(`Performing swap ${amount} XOS ➯ BNB, Expected output: ${expectedBnb} BNB, Minimum: ${minBnb} BNB`, "swap");

    const allowance = await wxosContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for WXOS`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 80000 };
      try {
        const approveGasLimit = await wxosContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Gas estimate for WXOS approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for WXOS approval: ${error.message}. Using default gas 80000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await wxosContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for WXOS`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve WXOS for ${amount} XOS`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for WXOS. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for WXOS`, "swap");
    }

    const swapParams = {
      tokenIn: WXOS_ADDRESS,
      tokenOut: BNB_ADDRESS,
      fee,
      recipient: globalWallet.address,
      amountIn: amountWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const multicallData = [encodedData];

    let txParams = { value: amountWei, nonce: null, gasLimit: 150000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData, { value: amountWei });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Gas estimate for swap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed for swap: ${error.message}. Using default gas 150000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} XOS ➯ BNB, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const result = await addTransactionToQueue(swapTxFunction, `Swap ${amount} XOS to BNB`);

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(`Swap successful ${amount} XOS ➯ BNB, Received: ${expectedBnb} BNB, Hash: ${getShortHash(result.receipt.transactionHash || result.txHash)}`, "success");
      return true;
    } else {
      addLog(`Failed to swap XOS to BNB. Transaction may have failed or is pending.`, "error");
      return false;
    }
  } else { 
    const bnbBalance = await getTokenBalance(BNB_ADDRESS);
    if (parseFloat(bnbBalance) < parseFloat(amount)) {
      addLog(`Insufficient BNB balance: ${bnbBalance} < ${amount}`, "warning");
      return false;
    }

    const expectedXos = (parseFloat(amount) * xosPerBnb).toFixed(6);
    const minXos = (parseFloat(expectedXos) * (1 - slippageTolerance)).toFixed(6);

    addLog(`Performing swap ${amount} BNB ➯ XOS, Expected output: ${expectedXos} XOS`, "swap");

    const allowance = await bnbContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for ${amount} BNB`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 100000 };
      try {
        const approveGasLimit = await bnbContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(130)) / BigInt(100);
        addLog(`Gas estimate for BNB approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for BNB approval: ${error.message}. Using default gas 100000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await bnbContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for ${amount} BNB, Hash: ${getShortHash(tx.hash)}`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve ${amount} BNB`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for BNB. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for ${amount} BNB`, "swap");
    }

    const swapParams = {
      tokenIn: BNB_ADDRESS,
      tokenOut: WXOS_ADDRESS,
      fee,
      recipient: SWAP_ROUTER_ADDRESS, 
      amountIn: amountWei,
      amountOutMinimum: 0, 
      sqrtPriceLimitX96: 0
    };

    const unwrapParams = {
      amountMinimum: 0, 
      recipient: globalWallet.address
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedSwapData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const encodedUnwrapData = swapInterface.encodeFunctionData('unwrapWETH9', [unwrapParams.amountMinimum, unwrapParams.recipient]);
    const multicallData = [encodedSwapData, encodedUnwrapData];

    let txParams = { value: 0, nonce: null, gasLimit: 400000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData);
      txParams.gasLimit = (gasLimit * BigInt(130)) / BigInt(100);
      addLog(`Gas estimate for swap and unwrap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed: ${error.message}. Using default gas 400000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} BNB ➯ XOS, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const swapResult = await addTransactionToQueue(swapTxFunction, `Swap ${amount} BNB to XOS`);
    if (!swapResult || !swapResult.receipt || swapResult.receipt.status !== 1) {
      addLog(`Failed to swap BNB to XOS. Check logs for details.`, "error");
      return false;
    }

    addLog(`Swap successful ${amount} BNB ➯ XOS, Hash: ${getShortHash(swapResult.receipt.transactionHash || swapResult.txHash)}`, "success");
    return true;
  }
}

async function autoSwapXosSol() {
  const direction = lastSwapDirectionXosSol === "XOS_TO_SOL" ? "SOL_TO_XOS" : "XOS_TO_SOL";
  lastSwapDirectionXosSol = direction;

  const ranges = randomAmountRanges["XOS_SOL"];
  const amount = direction === "XOS_TO_SOL" 
    ? getRandomNumber(ranges.XOS.min, ranges.XOS.max).toFixed(6)
    : getRandomNumber(ranges.SOL.min, ranges.SOL.max).toFixed(6);

  const wxosContract = new ethers.Contract(WXOS_ADDRESS, WXOS_ABI, globalWallet);
  const solContract = new ethers.Contract(SOL_ADDRESS, ERC20ABI, globalWallet);
  const swapRouterContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, globalWallet);
  const decimalsSol = await solContract.decimals();
  const amountWei = direction === "XOS_TO_SOL" 
    ? ethers.parseEther(amount) 
    : ethers.parseUnits(amount, decimalsSol);
  const fee = 500;
  const slippageTolerance = 0.005; 
  const xosPerSol = 0.32487; 
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  if (direction === "XOS_TO_SOL") {
    const xosBalance = await provider.getBalance(globalWallet.address);
    const estimatedGasCost = await estimateTransactionCost(150000);
    const totalRequired = ethers.parseEther(amount) + estimatedGasCost;
    if (xosBalance < totalRequired) {
      addLog(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)} (swap + gas)`, "warning");
      return false;
    }

    const expectedSol = (parseFloat(amount) / xosPerSol).toFixed(6);
    const minSol = (parseFloat(expectedSol) * (1 - slippageTolerance)).toFixed(6);
    const amountOutMinimum = ethers.parseUnits(minSol, decimalsSol);

    addLog(`Performing swap ${amount} XOS ➯ SOL, Expected output: ${expectedSol} SOL, Minimum: ${minSol} SOL`, "swap");

    const allowance = await wxosContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for WXOS`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 80000 };
      try {
        const approveGasLimit = await wxosContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Gas estimate for WXOS approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for WXOS approval: ${error.message}. Using default gas 80000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await wxosContract.approve(SW trouvées, amountWei, approveTxParams);
        addLog(`Approval transaction sent for WXOS`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve WXOS for ${amount} XOS`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for WXOS. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for WXOS`, "swap");
    }

    const swapParams = {
      tokenIn: WXOS_ADDRESS,
      tokenOut: SOL_ADDRESS,
      fee,
      recipient: globalWallet.address,
      amountIn: amountWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const multicallData = [encodedData];

    let txParams = { value: amountWei, nonce: null, gasLimit: 150000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData, { value: amountWei });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Gas estimate for swap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed for swap: ${error.message}. Using default gas 150000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} XOS ➯ SOL, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const result = await addTransactionToQueue(swapTxFunction, `Swap ${amount} XOS to SOL`);

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(`Swap successful ${amount} XOS ➯ SOL, Received: ${expectedSol} SOL, Hash: ${getShortHash(result.receipt.transactionHash || result.txHash)}`, "success");
      return true;
    } else {
      addLog(`Failed to swap XOS to SOL. Transaction may have failed or is pending.`, "error");
      return false;
    }
  } else { 
    const solBalance = await getTokenBalance(SOL_ADDRESS);
    if (parseFloat(solBalance) < parseFloat(amount)) {
      addLog(`Insufficient SOL balance: ${solBalance} < ${amount}`, "warning");
      return false;
    }

    const expectedXos = (parseFloat(amount) * xosPerSol).toFixed(6);
    const minXos = (parseFloat(expectedXos) * (1 - slippageTolerance)).toFixed(6);

    addLog(`Performing swap ${amount} SOL ➯ XOS, Expected output: ${expectedXos} XOS`, "swap");

    const allowance = await solContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for ${amount} SOL`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 100000 };
      try {
        const approveGasLimit = await solContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(130)) / BigInt(100);
        addLog(`Gas estimate for SOL approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for SOL approval: ${error.message}. Using default gas 100000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await solContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for ${amount} SOL, Hash: ${getShortHash(tx.hash)}`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve ${amount} SOL`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for SOL. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for ${amount} SOL`, "swap");
    }

    const swapParams = {
      tokenIn: SOL_ADDRESS,
      tokenOut: WXOS_ADDRESS,
      fee,
      recipient: SWAP_ROUTER_ADDRESS, 
      amountIn: amountWei,
      amountOutMinimum: 0, 
      sqrtPriceLimitX96: 0
    };

    const unwrapParams = {
      amountMinimum: 0, 
      recipient: globalWallet.address 
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedSwapData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const encodedUnwrapData = swapInterface.encodeFunctionData('unwrapWETH9', [unwrapParams.amountMinimum, unwrapParams.recipient]);
    const multicallData = [encodedSwapData, encodedUnwrapData];

    let txParams = { value: 0, nonce: null, gasLimit: 400000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData);
      txParams.gasLimit = (gasLimit * BigInt(130)) / BigInt(100);
      addLog(`Gas estimate for swap and unwrap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed: ${error.message}. Using default gas 400000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} SOL ➯ XOS, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const swapResult = await addTransactionToQueue(swapTxFunction, `Swap ${amount} SOL to XOS`);
    if (!swapResult || !swapResult.receipt || swapResult.receipt.status !== 1) {
      addLog(`Failed to swap SOL to XOS. Check logs for details.`, "error");
      return false;
    }

    addLog(`Swap successful ${amount} SOL ➯ XOS, Hash: ${getShortHash(swapResult.receipt.transactionHash || swapResult.txHash)}`, "success");
    return true;
  }
}

async function autoSwapXosJup() {
  const direction = lastSwapDirectionXosJup === "XOS_TO_JUP" ? "JUP_TO_XOS" : "XOS_TO_JUP";
  lastSwapDirectionXosJup = direction;

  const ranges = randomAmountRanges["XOS_JUP"];
  const amount = direction === "XOS_TO_JUP" 
    ? getRandomNumber(ranges.XOS.min, ranges.XOS.max).toFixed(6)
    : getRandomNumber(ranges.JUP.min, ranges.JUP.max).toFixed(6);

  const wxosContract = new ethers.Contract(WXOS_ADDRESS, WXOS_ABI, globalWallet);
  const jupContract = new ethers.Contract(JUP_ADDRESS, ERC20ABI, globalWallet);
  const swapRouterContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, globalWallet);
  const decimalsJup = await jupContract.decimals();
  const amountWei = direction === "XOS_TO_JUP" 
    ? ethers.parseEther(amount) 
    : ethers.parseUnits(amount, decimalsJup);
  const fee = 500; 
  const slippageTolerance = 0.005; 
  const xosPerJup = 27.747;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; 

  if (direction === "XOS_TO_JUP") {
    const xosBalance = await provider.getBalance(globalWallet.address);
    const estimatedGasCost = await estimateTransactionCost(150000);
    const totalRequired = ethers.parseEther(amount) + estimatedGasCost;
    if (xosBalance < totalRequired) {
      addLog(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)} (swap + gas)`, "warning");
      return false;
    }

    const expectedJup = (parseFloat(amount) / xosPerJup).toFixed(6);
    const minJup = (parseFloat(expectedJup) * (1 - slippageTolerance)).toFixed(6);
    const amountOutMinimum = ethers.parseUnits(minJup, decimalsJup);

    addLog(`Performing swap ${amount} XOS ➯ JUP, Expected output: ${expectedJup} JUP, Minimum: ${minJup} JUP`, "swap");

    const allowance = await wxosContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for WXOS`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 80000 };
      try {
        const approveGasLimit = await wxosContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Gas estimate for WXOS approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for WXOS approval: ${error.message}. Using default gas 80000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await wxosContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for WXOS`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve WXOS for ${amount} XOS`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for WXOS. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for WXOS`, "swap");
    }

    const swapParams = {
      tokenIn: WXOS_ADDRESS,
      tokenOut: JUP_ADDRESS,
      fee,
      recipient: globalWallet.address,
      amountIn: amountWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const multicallData = [encodedData];

    let txParams = { value: amountWei, nonce: null, gasLimit: 150000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData, { value: amountWei });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Gas estimate for swap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed for swap: ${error.message}. Using default gas 150000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} XOS ➯ JUP, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const result = await addTransactionToQueue(swapTxFunction, `Swap ${amount} XOS to JUP`);

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(`Swap successful ${amount} XOS ➯ JUP, Received: ${expectedJup} JUP, Hash: ${getShortHash(result.receipt.transactionHash || result.txHash)}`, "success");
      return true;
    } else {
      addLog(`Failed to swap XOS to JUP. Transaction may have failed or is pending.`, "error");
      return false;
    }
  } else { 
    const jupBalance = await getTokenBalance(JUP_ADDRESS);
    if (parseFloat(jupBalance) < parseFloat(amount)) {
      addLog(`Insufficient JUP balance: ${jupBalance} < ${amount}`, "warning");
      return false;
    }

    const expectedXos = (parseFloat(amount) * xosPerJup).toFixed(6);
    const minXos = (parseFloat(expectedXos) * (1 - slippageTolerance)).toFixed(6);

    addLog(`Performing swap ${amount} JUP ➯ XOS, Expected output: ${expectedXos} XOS`, "swap");

    const allowance = await jupContract.allowance(globalWallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountWei) {
      addLog(`Requesting approval for ${amount} JUP`, "swap");
      let approveTxParams = { nonce: null, gasLimit: 100000 };
      try {
        const approveGasLimit = await jupContract.estimateGas.approve(SWAP_ROUTER_ADDRESS, amountWei);
        approveTxParams.gasLimit = (approveGasLimit * BigInt(130)) / BigInt(100);
        addLog(`Gas estimate for JUP approval: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(`Gas estimation failed for JUP approval: ${error.message}. Using default gas 100000.`, "debug");
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await jupContract.approve(SWAP_ROUTER_ADDRESS, amountWei, approveTxParams);
        addLog(`Approval transaction sent for ${amount} JUP, Hash: ${getShortHash(tx.hash)}`, "swap");
        return tx;
      };
      const approveResult = await addTransactionToQueue(approveTxFunction, `Approve ${amount} JUP`);
      if (!approveResult || !approveResult.receipt || approveResult.receipt.status !== 1) {
        addLog(`Approval failed for JUP. Cancelling swap.`, "error");
        return false;
      }
      addLog(`Approval successful for ${amount} JUP`, "swap");
    }

    const swapParams = {
      tokenIn: JUP_ADDRESS,
      tokenOut: WXOS_ADDRESS,
      fee,
      recipient: SWAP_ROUTER_ADDRESS, 
      amountIn: amountWei,
      amountOutMinimum: 0, 
      sqrtPriceLimitX96: 0
    };

    const unwrapParams = {
      amountMinimum: 0,
      recipient: globalWallet.address
    };

    const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encodedSwapData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
    const encodedUnwrapData = swapInterface.encodeFunctionData('unwrapWETH9', [unwrapParams.amountMinimum, unwrapParams.recipient]);
    const multicallData = [encodedSwapData, encodedUnwrapData];

    let txParams = { value: 0, nonce: null, gasLimit: 400000 };
    try {
      const gasLimit = await swapRouterContract.estimateGas.multicall(deadline, multicallData);
      txParams.gasLimit = (gasLimit * BigInt(130)) / BigInt(100);
      addLog(`Gas estimate for swap and unwrap: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(`Gas estimation failed: ${error.message}. Using default gas 400000.`, "debug");
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapRouterContract.multicall(deadline, multicallData, txParams);
      addLog(`Tx sent ${amount} JUP ➯ XOS, Hash: ${getShortHash(tx.hash)}`, "swap");
      return tx;
    };

    const swapResult = await addTransactionToQueue(swapTxFunction, `Swap ${amount} JUP to XOS`);
    if (!swapResult || !swapResult.receipt || swapResult.receipt.status !== 1) {
      addLog(`Failed to swap JUP to XOS. Check logs for details.`, "error");
      return false;
    }

    addLog(`Swap successful ${amount} JUP ➯ XOS, Hash: ${getShortHash(swapResult.receipt.transactionHash || swapResult.txHash)}`, "success");
    return true;
  }
}

async function runAutoSwap(pair, autoSwapFunction, lastSwapDirection) {
  promptBox.setFront();
  promptBox.readInput(`Enter the number of swaps for ${pair}`, "", async (err, value) => {
    promptBox.hide();
    safeRender();
    if (err || !value) {
      addLog(`XOS Dex: Invalid or cancelled input for ${pair}.`, "swap");
      return;
    }
    const loopCount = parseInt(value);
    if (isNaN(loopCount)) {
      addLog(`XOS Dex: Input must be a number for ${pair}.`, "swap");
      return;
    }
    addLog(`XOS Dex: Starting ${loopCount} swap iterations for ${pair}.`, "swap");

    swapRunning = true;
    swapCancelled = false;
    mainMenu.setItems(getMainMenuItems());
    xosDexSubMenu.setItems(getXosDexMenuItems());
    xosDexSubMenu.show();
    safeRender();

    for (let i = 1; i <= loopCount; i++) {
      if (swapCancelled) {
        addLog(`XOS Dex: Auto swap ${pair} stopped at cycle ${i}.`, "swap");
        break;
      }
      addLog(`Starting swap ${i} for ${pair}: Direction ${lastSwapDirection === "XOS_TO_TOKEN" ? "TOKEN_TO_XOS" : "XOS_TO_TOKEN"}`, "swap");
      const success = await autoSwapFunction();
      if (success) {
        await updateWalletData();
      }
      if (i < loopCount) {
        const delayTime = getRandomDelay();
        const minutes = Math.floor(delayTime / 60000);
        const seconds = Math.floor((delayTime % 60000) / 1000);
        addLog(`Swap ${i} for ${pair} completed. Waiting ${minutes} minutes ${seconds} seconds.`, "swap");
        await waitWithCancel(delayTime, "swap");
        if (swapCancelled) {
          addLog(`XOS Dex: Stopped during waiting period for ${pair}.`, "swap");
          break;
        }
      }
    }
    swapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    xosDexSubMenu.setItems(getXosDexMenuItems());
    safeRender();
    addLog(`XOS Dex: Auto swap for ${pair} completed.`, "swap");
  });
}

function changeRandomAmount(pair) {
  const pairKey = pair.replace(" & ", "_");
  const token2 = pair.split(" & ")[1];
  promptBox.setFront();
  promptBox.input(`Enter random amount range for XOS on pair ${pair} (format: min,max, e.g., 0.1,0.5)`, "", (err, valueXos) => {
    promptBox.hide();
    safeRender();
    if (err || !valueXos) {
      addLog(`Change Random Amount: Input for XOS on ${pair} cancelled.`, "system");
      changeRandomAmountSubMenu.show();
      changeRandomAmountSubMenu.focus();
      safeRender();
      return;
    }
    const [minXos, maxXos] = valueXos.split(",").map(v => parseFloat(v.trim()));
    if (isNaN(minXos) || isNaN(maxXos) || minXos <= 0 || maxXos <= minXos) {
      addLog(`Change Random Amount: Invalid input for XOS on ${pair}. Use format min,max (e.g., 0.1,0.5) with min > 0 and max > min.`, "error");
      changeRandomAmountSubMenu.show();
      changeRandomAmountSubMenu.focus();
      safeRender();
      return;
    }

    promptBox.setFront();
    promptBox.input(`Enter random amount range for ${token2} on pair ${pair} (format: min,max, e.g., 0.1,0.5)`, "", (err, valueToken2) => {
      promptBox.hide();
      safeRender();
      if (err || !valueToken2) {
        addLog(`Change Random Amount: Input for ${token2} on ${pair} cancelled.`, "system");
        changeRandomAmountSubMenu.show();
        changeRandomAmountSubMenu.focus();
        safeRender();
        return;
      }
      const [minToken2, maxToken2] = valueToken2.split(",").map(v => parseFloat(v.trim()));
      if (isNaN(minToken2) || isNaN(maxToken2) || minToken2 <= 0 || maxToken2 <= minToken2) {
        addLog(`Change Random Amount: Invalid input for ${token2} on ${pair}. Use format min,max (e.g., 0.1,0.5) with min > 0 and max > min.`, "error");
        changeRandomAmountSubMenu.show();
        changeRandomAmountSubMenu.focus();
        safeRender();
        return;
      }

      randomAmountRanges[pairKey] = {
        XOS: { min: minXos, max: maxXos },
        [token2]: { min: minToken2, max: maxToken2 }
      };
      addLog(`Change Random Amount: Random amount for ${pair} updated to XOS: ${minXos} - ${maxXos}, ${token2}: ${minToken2} - ${maxToken2}.`, "success");
      changeRandomAmountSubMenu.show();
      changeRandomAmountSubMenu.focus();
      safeRender();
    });
  });
}

const screen = blessed.screen({
  smartCSR: true,
  title: "XOS Dex",
  fullUnicode: true,
  mouse: true
});

let renderTimeout;

function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => { screen.render(); }, 50);
}

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white", bg: "default" }
});

figlet.text("ADB NODE".toUpperCase(), { font: "ANSI Shadow" }, (err, data) => {
  if (err) headerBox.setContent("{center}{bold}NT Exhaust{/bold}{/center}");
  else headerBox.setContent(`{center}{bold}{bright-cyan-fg}${data}{/bright-cyan-fg}{/bold}{/center}`);
  safeRender();
});

const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content: "{center}{bold}{bright-yellow-fg}✦ ✦ XOS DEX AUTO SWAP ✦ ✦{/bright-yellow-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white", bg: "default" }
});

const logsBox = blessed.box({
  label: " Transaction Logs ",
  left: 0,
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  style: { border: { fg: "red" }, fg: "white" },
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  content: ""
});

const walletBox = blessed.box({
  label: " Wallet Information ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, fg: "white", bg: "default" },
  content: "Loading wallet data..."
});

const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "green", fg: "black" } },
  items: getMainMenuItems()
});

function getMainMenuItems() {
  let items = [];
  if (swapRunning) items.push("Stop Transaction");
  items = items.concat(["XOS Dex", "Clear Transaction Logs", "Refresh", "Exit"]);
  return items;
}

function getXosDexMenuItems() {
  let items = [];
  if (swapRunning) items.push("Stop Transaction");
  items = items.concat([
    "Auto Swap XOS & WXOS",
    "Auto Swap XOS & USDC",
    "Auto Swap XOS & BNB",
    "Auto Swap XOS & SOL",
    "Auto Swap XOS & JUP",
    "Change Random Amount",
    "Clear Transaction Logs",
    "Back To Main Menu",
    "Refresh"
  ]);
  return items;
}

const xosDexSubMenu = blessed.list({
  label: " XOS Dex Sub Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: getXosDexMenuItems()
});
xosDexSubMenu.hide();

const changeRandomAmountSubMenu = blessed.list({
  label: " Change Random Amount ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: ["XOS & WXOS", "XOS & USDC", "XOS & BNB", "XOS & SOL", "XOS & JUP", "Back To XOS Dex Menu"]
});
changeRandomAmountSubMenu.hide();

const promptBox = blessed.prompt({
  parent: screen,
  border: "line",
  height: 5,
  width: "60%",
  top: "center",
  left: "center",
  label: "{bright-blue-fg}Prompt{/bright-blue-fg}",
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  style: { fg: "bright-red", bg: "default", border: { fg: "red" } }
});

screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(xosDexSubMenu);
screen.append(changeRandomAmountSubMenu);

function adjustLayout() {
  const screenHeight = screen.height;
  const screenWidth = screen.width;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.top = 0;
  headerBox.height = headerHeight;
  headerBox.width = "100%";
  descriptionBox.top = "22%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = screenHeight - (headerHeight + descriptionBox.height);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = headerHeight + descriptionBox.height + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  xosDexSubMenu.top = mainMenu.top;
  xosDexSubMenu.left = mainMenu.left;
  xosDexSubMenu.width = mainMenu.width;
  xosDexSubMenu.height = mainMenu.height;
  changeRandomAmountSubMenu.top = mainMenu.top;
  changeRandomAmountSubMenu.left = mainMenu.left;
  changeRandomAmountSubMenu.width = mainMenu.width;
  changeRandomAmountSubMenu.height = mainMenu.height;
  safeRender();
}

screen.on("resize", adjustLayout);
adjustLayout();

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "XOS Dex") {
    xosDexSubMenu.show();
    xosDexSubMenu.focus();
    safeRender();
  } else if (selected === "Stop Transaction") {
    if (swapRunning) {
      swapCancelled = true;
      addLog("Stop Transaction: Swap transactions will be stopped.", "system");
    }
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Refresh") {
    updateWalletData();
    safeRender();
    addLog("Refreshed", "system");
  } else if (selected === "Exit") {
    process.exit(0);
  }
});

xosDexSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Auto Swap XOS & WXOS") {
    if (swapRunning) {
      addLog("XOS Dex transaction is already running. Stop the transaction first.", "warning");
    } else {
      runAutoSwap("XOS & WXOS", autoSwapXosWxos, lastSwapDirectionXosWxos);
    }
  } else if (selected === "Auto Swap XOS & USDC") {
    if (swapRunning) {
      addLog("XOS Dex transaction is already running. Stop the transaction first.", "warning");
    } else {
      runAutoSwap("XOS & USDC", autoSwapXosUsdc, lastSwapDirectionXosUsdc);
    }
  } else if (selected === "Auto Swap XOS & BNB") {
    if (swapRunning) {
      addLog("XOS Dex transaction is already running. Stop the transaction first.", "warning");
    } else {
      runAutoSwap("XOS & BNB", autoSwapXosBnb, lastSwapDirectionXosBnb);
    }
  } else if (selected === "Auto Swap XOS & SOL") {
    if (swapRunning) {
      addLog("XOS Dex transaction is already running. Stop the transaction first.", "warning");
    } else {
      runAutoSwap("XOS & SOL", autoSwapXosSol, lastSwapDirectionXosSol);
    }
  } else if (selected === "Auto Swap XOS & JUP") {
    if (swapRunning) {
      addLog("XOS Dex transaction is already running. Stop the transaction first.", "warning");
    } else {
      runAutoSwap("XOS & JUP", autoSwapXosJup, lastSwapDirectionXosJup);
    }
  } else if (selected === "Change Random Amount") {
    xosDexSubMenu.hide();
    changeRandomAmountSubMenu.show();
    changeRandomAmountSubMenu.focus();
    safeRender();
  } else if (selected === "Stop Transaction") {
    if (swapRunning) {
      swapCancelled = true;
      addLog("XOS Dex: Stop transaction command received.", "swap");
    } else {
      addLog("XOS Dex: No transaction is currently running.", "swap");
    }
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Back To Main Menu") {
    xosDexSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Refresh") {
    updateWalletData();
    safeRender();
    addLog("Refreshed", "system");
  }
});

changeRandomAmountSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "XOS & WXOS") {
    changeRandomAmount("XOS & WXOS");
  } else if (selected === "XOS & USDC") {
    changeRandomAmount("XOS & USDC");
  } else if (selected === "XOS & BNB") {
    changeRandomAmount("XOS & BNB");
  } else if (selected === "XOS & SOL") {
    changeRandomAmount("XOS & SOL");
  } else if (selected === "XOS & JUP") {
    changeRandomAmount("XOS & JUP");
  } else if (selected === "Back To XOS Dex Menu") {
    changeRandomAmountSubMenu.hide();
    xosDexSubMenu.show();
    xosDexSubMenu.focus();
    safeRender();
  }
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => { logsBox.scroll(-1); safeRender(); });
screen.key(["C-down"], () => { logsBox.scroll(1); safeRender(); });

safeRender();
mainMenu.focus();
addLog("Don't forget to subscribe to YouTube and Telegram @NTExhaust!", "system");
updateWalletData();
