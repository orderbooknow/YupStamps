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

// Функция определения, является ли токен маркой (Postage Stamp)
function isPostageStamp(token) {
    const title = token.title || '';
    // Postage Stamp марки обычно имеют такой формат
    if (title.includes('Postage Stamp')) return true;
    // Также проверяем по наличию rarity (редкость есть только у марок)
    if (token.rarity && token.rarity !== 'null') return true;
    return false;
}

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

function calculateSplitStats(allTokens, dynamicTokens) {
    // Разделяем токены на МАРКИ (Postage + Dynamic) и ПРОЧИЕ NFT
    const dynamicSet = new Set(dynamicTokens.map(t => t.token_id));
    
    const stamps = [];      // марки (Postage + Dynamic)
    const otherNFTs = [];   // все остальные NFT
    
    for (const token of allTokens) {
        const isDynamic = dynamicSet.has(token.token_id);
        const isPostage = isPostageStamp(token);
        
        if (isDynamic || isPostage) {
            stamps.push(token);
        } else {
            otherNFTs.push(token);
        }
    }
    
    // Функция расчета статистики для массива токенов
    function calcStats(tokens) {
        let total = tokens.length;
        let burned = 0;
        let alchemy = 0;
        const holdersSet = new Set();
        
        for (const token of tokens) {
            const owner = token.owner_id;
            if (!owner || owner === 'null' || owner === BURNER_ACCOUNT) {
                burned++;
            } else if (owner === ALCHEMY_ACCOUNT) {
                alchemy++;
            } else {
                holdersSet.add(owner);
            }
        }
        
        return {
            total: total,
            burned: burned,
            alchemy: alchemy,
            holders: holdersSet.size
        };
    }
    
    const stampsStats = calcStats(stamps);
    const otherStats = calcStats(otherNFTs);
    
    return {
        stamps: stampsStats,
        other: otherStats,
        totalTokens: allTokens.length,
        stampsCount: stamps.length,
        otherCount: otherNFTs.length
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
        fullMessage = `🏆 <b>Yupland Stamps Update</b> 🏆\n\n` +
            `<b>📮 МАРКИ (Postage + Dynamic):</b>\n` +
            `   📊 Всего: ${stats.stamps.total.toLocaleString()}\n` +
            `   🔥 Сожжено: ${stats.stamps.burned.toLocaleString()}\n` +
            `   👥 Держателей: ${stats.stamps.holders.toLocaleString()}\n` +
            `   🏪 В Лавке: ${stats.stamps.alchemy.toLocaleString()}\n\n` +
            `<b>📦 ПРОЧИЕ NFT (не марки):</b>\n` +
            `   📊 Всего: ${stats.other.total.toLocaleString()}\n` +
            `   🔥 Сожжено: ${stats.other.burned.toLocaleString()}\n` +
            `   👥 Держателей: ${stats.other.holders.toLocaleString()}\n` +
            `   🏪 В Лавке: ${stats.other.alchemy.toLocaleString()}\n\n` +
            `<b>📊 ВСЕГО NFT на контракте:</b>\n` +
            `   📊 Всего: ${stats.totalTokens.toLocaleString()}\n\n` +
            `🔄 Обновлено владельцев: ${updatedCount}\n` +
            `✨ Динамических марок: ${stats.dynamicStamps || 0}\n\n` +
            `⏱️ Время: ${duration} сек`;
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
        
        // Подсчет раздельной статистики ДО обновления (для отчета)
        const splitStats = calculateSplitStats(allTokens, dynamicTokens);
        console.log(`\n📊 SPLIT STATISTICS:`);
        console.log(`   📮 Stamps: ${splitStats.stamps.total} (burned: ${splitStats.stamps.burned}, holders: ${splitStats.stamps.holders}, alchemy: ${splitStats.stamps.alchemy})`);
        console.log(`   📦 Other NFTs: ${splitStats.other.total} (burned: ${splitStats.other.burned}, holders: ${splitStats.other.holders}, alchemy: ${splitStats.other.alchemy})`);
        
        const { updated, errors } = await updateStampsIncremental(allTokens);
        const added = await updateDynamicStamps(allTokens);
        
        splitStats.dynamicStamps = added;
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        await sendTelegramNotification(updated, splitStats, duration, errors > 0, errors > 0 ? 'Some errors occurred during update' : '');
        
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
