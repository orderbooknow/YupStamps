const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_KEY = process.env.SENDLER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_KEY || !API_KEY) {
    console.error('❌ Missing SUPABASE_SERVICE_KEY or SENDLER_API_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { transport: WebSocket }
});

const API_URL = 'https://api.sendler.xyz/nft/list/?contract_address=yuplandshop.mintbase1.near&limit=10000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DYNAMIC_NAMES = [
    'Stamp (legendary - 1 Lv)',
    'Stamp (legendary - 2 Lv)',
    'Stamp (legendary - 3 Lv)',
    'Stamp (legendary - 4 Lv)',
    'Stamp (legendary - 5 Lv)',
    'Stamp (legendary - 6 Lv)',
    'Stamp (legendary - 7 Lv)',
    'Old stamp (legendary)'
];

const BURNER_ACCOUNT = 'darai_duplo.near';
const ALCHEMY_ACCOUNT = 'sendler-alchemy.near';

async function fetchAllTokens() {
    console.log('🔄 Loading tokens from Sendler API...');
    let allTokens = [], cursor = null, page = 0;
    while (true) {
        let url = API_URL;
        if (cursor) url += `&cursor=${cursor}`;
        const response = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        allTokens.push(...data.items);
        console.log(`📦 Page ${++page}: ${data.items.length} items, total ${allTokens.length}`);
        if (data.next_cursor) { cursor = data.next_cursor; await sleep(500); }
        else break;
    }
    return allTokens;
}

async function updateStampsIncremental(allTokens) {
    console.log('📊 Updating stamps table...');
    let oldTokens = [];
    let from = 0;
    const limit = 1000;
    let hasMore = true;
    
    while (hasMore) {
        const { data, error } = await supabase
            .from('stamps')
            .select('token_id, owner_id')
            .range(from, from + limit - 1);
        if (error) throw error;
        oldTokens.push(...data);
        from += limit;
        hasMore = data.length === limit;
    }
    
    const oldMap = new Map(oldTokens.map(t => [t.token_id, t.owner_id]));
    console.log(`📊 Stamps in DB: ${oldMap.size}`);
    
    const apiMap = new Map(allTokens.map(t => [t.token_id, t.owner_id]));
    
    let updated = 0;
    let errors = 0;
    
    for (const tokenId of oldMap.keys()) {
        const apiOwner = apiMap.get(tokenId);
        const dbOwner = oldMap.get(tokenId);
        if (apiOwner && apiOwner !== dbOwner) {
            const { error } = await supabase
                .from('stamps')
                .update({ owner_id: apiOwner })
                .eq('token_id', tokenId);
            if (error) errors++;
            else updated++;
        }
    }
    console.log(`✅ Updated: ${updated}, errors: ${errors}`);
    return { updated, errors };
}

async function updateDynamicStamps(allTokens) {
    console.log('📊 Updating dynamic stamps...');
    const dynamicTokens = allTokens.filter(t => DYNAMIC_NAMES.includes(t.title));
    console.log(`📊 Dynamic tokens found: ${dynamicTokens.length}`);
    
    await supabase.from('stamp_instances').delete().neq('token_id', '');
    console.log('🧹 Cleared stamp_instances table');
    
    let added = 0;
    for (const token of dynamicTokens) {
        const { error } = await supabase.from('stamp_instances').insert({
            token_id: token.token_id,
            name: token.title,
            owner_id: token.owner_id,
            image_url: token.media,
            last_updated: new Date()
        });
        if (error) console.error(`❌ Error ${token.token_id}: ${error.message}`);
        else added++;
    }
    console.log(`✅ Added: ${added} dynamic stamps`);
    return added;
}

function calculateStats(allTokens, dynamicTokens) {
    let burnedTotal = 0;
    let burnedStamps = 0;
    let burnedDynamic = 0;
    
    let alchemyTotal = 0;
    let alchemyStamps = 0;
    let alchemyDynamic = 0;
    
    const allHolders = new Set();
    const stampsHolders = new Set();
    const dynamicHolders = new Set();
    
    // Обрабатываем обычные марки (все токены, кроме динамических)
    const normalTokens = allTokens.filter(t => !DYNAMIC_NAMES.includes(t.title));
    
    for (const token of normalTokens) {
        const owner = token.owner_id;
        
        // Холдеры (исключаем null, сжигателя, лавку)
        if (owner && owner !== 'null' && owner !== BURNER_ACCOUNT && owner !== ALCHEMY_ACCOUNT) {
            stampsHolders.add(owner);
            allHolders.add(owner);
        }
        
        // Сожжённые
        if (!owner || owner === 'null' || owner === BURNER_ACCOUNT) {
            burnedStamps++;
            burnedTotal++;
        }
        
        // В лавке
        if (owner === ALCHEMY_ACCOUNT) {
            alchemyStamps++;
            alchemyTotal++;
        }
    }
    
    // Обрабатываем динамические марки
    for (const token of dynamicTokens) {
        const owner = token.owner_id;
        
        // Холдеры (исключаем null, сжигателя, лавку)
        if (owner && owner !== 'null' && owner !== BURNER_ACCOUNT && owner !== ALCHEMY_ACCOUNT) {
            dynamicHolders.add(owner);
            allHolders.add(owner);
        }
        
        // Сожжённые
        if (!owner || owner === 'null' || owner === BURNER_ACCOUNT) {
            burnedDynamic++;
            burnedTotal++;
        }
        
        // В лавке
        if (owner === ALCHEMY_ACCOUNT) {
            alchemyDynamic++;
            alchemyTotal++;
        }
    }
    
    const stampsHoldersTotal = stampsHolders.size + dynamicHolders.size;
    const totalStamps = normalTokens.length + dynamicTokens.length;
    
    return {
        totalTokens: allTokens.length,
        totalStamps: totalStamps,
        burnedTotal: burnedTotal,
        burnedStamps: burnedStamps + burnedDynamic,
        holdersTotal: allHolders.size,
        holdersStamps: stampsHoldersTotal,
        alchemyTotal: alchemyTotal,
        alchemyStamps: alchemyStamps + alchemyDynamic
    };
}

async function sendTelegramNotification(updatedCount, stats, duration, isError = false, errorMessage = '') {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram not configured, skipping notification');
        return;
    }
    
    let fullMessage = '';
    if (isError) {
        fullMessage = `❌ <b>Yupland Stamps Update FAILED</b>\n\n${errorMessage}\n⏱️ Duration: ${duration} sec`;
    } else {
        fullMessage = `✅ <b>Yupland Stamps Update</b>\n\n` +
            `📊 Total tokens: ${stats.totalTokens.toLocaleString()}\n` +
            `📮 Stamps: ${stats.totalStamps.toLocaleString()}\n` +
            `🔄 Owners updated: ${updatedCount}\n` +
            `✨ Dynamic stamps: ${stats.dynamicStamps || 0}\n\n` +
            `🔥 Burned total: ${stats.burnedTotal.toLocaleString()}\n` +
            `🔥 Burned stamps: ${stats.burnedStamps.toLocaleString()}\n\n` +
            `👥 Holders total: ${stats.holdersTotal.toLocaleString()}\n` +
            `👥 Holders stamps: ${stats.holdersStamps.toLocaleString()}\n\n` +
            `🏪 Alchemy total: ${stats.alchemyTotal.toLocaleString()}\n` +
            `🏪 Alchemy stamps: ${stats.alchemyStamps.toLocaleString()}\n\n` +
            `⏱️ Duration: ${duration} sec`;
    }
    
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: fullMessage,
                parse_mode: 'HTML'
            })
        });
        if (response.ok) {
            console.log('📨 Telegram notification sent');
        } else {
            console.log('⚠️ Telegram notification failed');
        }
    } catch (err) {
        console.log('⚠️ Telegram notification error:', err.message);
    }
}

async function main() {
    const startTime = Date.now();
    console.log(`🚀 Starting update at ${new Date().toISOString()}`);
    
    try {
        const allTokens = await fetchAllTokens();
        console.log(`📊 Total tokens: ${allTokens.length}`);
        
        const dynamicTokens = allTokens.filter(t => DYNAMIC_NAMES.includes(t.title));
        console.log(`📊 Dynamic tokens: ${dynamicTokens.length}`);
        
        const { updated, errors } = await updateStampsIncremental(allTokens);
        const added = await updateDynamicStamps(allTokens);
        
        const stats = calculateStats(allTokens, dynamicTokens);
        stats.dynamicStamps = added;
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        await sendTelegramNotification(updated, stats, duration, errors > 0, errors > 0 ? 'Some errors occurred during update' : '');
        
        if (errors > 0) {
            console.log('⚠️ Update completed with errors');
        } else {
            console.log('🎉 UPDATE COMPLETED SUCCESSFULLY!');
        }
        
    } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error('❌ Fatal error:', error.message);
        await sendTelegramNotification(0, null, duration, true, error.message);
        process.exit(1);
    }
}

main().catch(console.error);
