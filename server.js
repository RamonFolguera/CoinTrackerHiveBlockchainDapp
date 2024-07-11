import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import PQueue from 'p-queue';

dotenv.config();

const app = express();
app.use(cors());

console.log("Server starting...");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const fetchTokenPrice = async (symbol, retries = 7, backoff = 500) => {
    try {
        console.log(`Fetching price for ${symbol}...`);
        const response = await axios.post('https://api.hive-engine.com/rpc/contracts', {
            jsonrpc: '2.0',
            method: 'find',
            params: {
                contract: 'market',
                table: 'metrics',
                query: { symbol },
                limit: 1
            },
            id: 1
        });

        if (!response.data.result || response.data.result.length === 0) {
            console.log(`No price data found for ${symbol}`);
            return 0;
        }

        const tokenData = response.data.result[0];
        const lastPrice = tokenData && tokenData.lastPrice ? parseFloat(tokenData.lastPrice) : 0;
        console.log(`Fetched price for ${symbol}: ${lastPrice}`);
        return lastPrice;
    } catch (error) {
        console.error(`Failed to fetch price for ${symbol}: ${error.message}`);
        if (retries > 0) {
            console.warn(`Retrying fetch price for ${symbol} (${retries} retries left, backoff: ${backoff}ms)`);
            await sleep(backoff);
            return fetchTokenPrice(symbol, retries - 1, backoff * 2); // Exponential backoff
        } else {
            console.error(`All retries failed for ${symbol}. Assigning price 0.`);
            return 0;
        }
    }
};

app.get('/tokens/:username', async (req, res) => {
    const username = req.params.username;

    try {
        console.log(`Fetching account data for ${username}...`);
        const accountResponse = await axios.post('https://api.hive.blog', {
            jsonrpc: '2.0',
            method: 'condenser_api.get_accounts',
            params: [[username]],
            id: 1
        });

        const account = accountResponse.data.result[0];
        if (!account) {
            console.error('Account not found');
            return res.status(404).json({ error: 'Account not found' });
        }

        const hiveBalance = parseFloat(account.balance.split(' ')[0]);
        const savingsBalance = parseFloat(account.savings_balance.split(' ')[0]);
        const hbdBalance = parseFloat(account.hbd_balance.split(' ')[0]);
        const savingsHbdBalance = parseFloat(account.savings_hbd_balance.split(' ')[0]);
        const vestingShares = parseFloat(account.vesting_shares.split(' ')[0]);

        console.log('Fetching Hive price...');
        const hivePriceResponse = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd');
        const hivePrice = hivePriceResponse.data.hive.usd;
        console.log(`Fetched Hive price: ${hivePrice}`);

        console.log('Fetching dynamic global properties...');
        const dynamicGlobalPropertiesResponse = await axios.post('https://api.hive.blog', {
            jsonrpc: '2.0',
            method: 'condenser_api.get_dynamic_global_properties',
            params: [],
            id: 1
        });

        const dynamicGlobalProperties = dynamicGlobalPropertiesResponse.data.result;
        const totalVestingShares = parseFloat(dynamicGlobalProperties.total_vesting_shares.split(' ')[0]);
        const totalVestingFundHive = parseFloat(dynamicGlobalProperties.total_vesting_fund_hive.split(' ')[0]);
        const hivePower = (vestingShares / totalVestingShares) * totalVestingFundHive;

        console.log('Fetching token balances from Hive Engine...');
        const tokenResponse = await axios.post('https://api.hive-engine.com/rpc/contracts', {
            jsonrpc: '2.0',
            method: 'find',
            params: {
                contract: 'tokens',
                table: 'balances',
                query: { account: username },
                limit: 1000
            },
            id: 1
        });

        const otherTokens = tokenResponse.data.result;

        if (!otherTokens || otherTokens.length === 0) {
            console.error('No tokens found for the user');
            return res.status(404).json({ error: 'No tokens found for the user' });
        }

        console.log('Fetching token prices...');
        const tokensData = {};
        const failedTokens = [];
        const queue = new PQueue({ concurrency: 5 });

        await Promise.all(otherTokens.map(token => queue.add(async () => {
            const symbol = token.symbol;
            let price;
            if (symbol === 'SWAP.HIVE') {
                price = hivePrice;
                console.log(`Assigned Hive price to SWAP.HIVE: ${price}`);
            } else {
                price = await fetchTokenPrice(symbol);
                if (price === 0) {
                    console.warn(`Price for ${symbol} is 0. This might indicate no market data available.`);
                    failedTokens.push(symbol);
                }
            }
            tokensData[symbol] = price;
            console.log(`Token: ${symbol}, Price: ${price}`);
        })));

        const result = {
            balance: hiveBalance,
            savings_balance: savingsBalance,
            hbd_balance: hbdBalance,
            savings_hbd_balance: savingsHbdBalance,
            hive_power: hivePower,
            hivePrice,
            tokensData,
            otherTokens,
            failedTokens
        };

        console.log('Result:', JSON.stringify(result, null, 2));
        res.json(result);
    } catch (error) {
        console.error(`Error processing request for ${username}: ${error.message}`);
        res.status(500).send({ error: 'Error processing request', details: error.message });
    }
});

// Ruta de prueba para STARPRO
app.get('/tokens/test/starpro', async (req, res) => {
    const symbol = 'STARPRO';

    try {
        console.log(`Fetching token price for ${symbol}...`);
        const price = await fetchTokenPrice(symbol);
        
        const result = {
            token: symbol,
            price
        };

        console.log('Result:', JSON.stringify(result, null, 2));
        res.json(result);
    } catch (error) {
        console.error(`Error processing request for ${symbol}: ${error.message}`);
        res.status(500).send({ error: 'Error processing request', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
