const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SENDLER_API_URL = 'https://api.sendler.xyz/nft/list/?contract_address=yuplandshop.mintbase1.near&limit=10000';
const SENDLER_API_KEY = 'pR7xQnL2mV9cYfK4uD8sTjH1wB5eZaCgX0oNiUyE6lA';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BURNER_ACCOUNT = 'darai_duplo.near';
const ALCHEMY_ACCOUNT = 'sendler-alchemy.near';

// Динамические марки (они считаются марками)
const DYNAMIC_NAMES = [
    'Energy of the East', 'Tiger Energy', 'Fairy Phoenix', 'Spirit of the Cherry Blossom',
    'Blossom Dancer', 'Celestial Pheonix', 'Mystic Apple', 'Dragon Heart'
];

// Функция проверки, является ли токен МАРКОЙ
function isStamp(token) {
    const title = token.title || token.metadata?.title || '';
    const baseName = token.base_name || '';
    
    // Динамические марки
    if (DYNAMIC_NAMES.some(name => title.includes(name) || baseName.includes(name))) {
        return true;
    }
    
    // Postage Stamp марки
    if (title.includes('Postage Stamp')) {
        return true;
    }
    
    // Если есть base_name и он не пустой — марка
    if (baseName && baseName.length > 0 && baseName !== 'null' && baseName !== 'undefined') {
        return true;
    }
    
    // Если есть rarity — марка
    if (token.rarity && token.rarity !== 'null' && token.rarity !== 'undefined') {
        return true;
    }
    
    // Если есть group_name — марка
    if (token.group_name && token.group_name !== 'null' && token.group_name !== 'undefined') {
        return true;
    }
    
    return false;
}

function getOwnerId(token) {
    if (token.owner_id && token.owner_id !== 'null') return token.owner_id;
    if (token.owner && token.owner !== 'null') return token.owner;
    if (token.minter && token.minter !== 'null') return token.minter;
    return null;
}

async function fetchAllTokens() {
    let allTokens = [];
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    
    while (hasMore) {
        const url = `${SENDLER_API_URL}&offset=${offset}`;
        console.log(`📡 Fetching tokens offset ${offset}...`);
        
        try {
            const response = await fetch(url, {
                headers: { 'x-api-key': SENDLER_API_KEY }
            });
            const data = await response.json();
            
            if (!data.results || data.results.length === 0) break;
            
            allTokens.push(...data.results);
            console.log(`   ✅ Got ${data.results.length} tokens (total: ${allTokens.length})`);
            
            hasMore = data.next !== null;
            offset += limit;
            
            await new Promise(r => setTimeout(r, 200));
        } catch (err) {
            console.error(`❌ Error fetching offset ${offset}:`, err);
            break;
        }
    }
    
    return allTokens;
}

// Расчет статистики для набора токенов
function calculateStatsForTokens(tokens) {
    let total = tokens.length;
    let burnedCount = 0;
    let alchemyCount = 0;
    const holdersSet = new Set();
    
    tokens.forEach(token => {
        const owner = getOwnerId(token);
        if (!owner) return;
        
        if (owner === BURNER_ACCOUNT) {
            burnedCount++;
        } else if (owner === ALCHEMY_ACCOUNT) {
            alchemyCount++;
        } else {
            holdersSet.add(owner);
        }
    });
    
    return {
        total: total,
        burned: burnedCount,
        alchemy: alchemyCount,
        holders: holdersSet.size
    };
}

async function updateStampsTable(tokens) {
    // Обновляем ТОЛЬКО марки в таблице stamps
    const stampTokens = tokens.filter(t => isStamp(t));
    let updatedCount = 0;
    
    for (const token of stampTokens) {
        const ownerId = getOwnerId(token);
        if (!ownerId) continue;
        
        const { error } = await supabase
            .from('stamps')
            .update({ 
                owner_id: ownerId,
                updated_at: new Date().toISOString()
            })
            .eq('token_id', token.token_id);
        
        if (!error || error.code === 'PGRST116') {
            updatedCount++;
        }
    }
    
    return updatedCount;
}

async function updateDynamicInstances(tokens) {
    const dynamicTokens = tokens.filter(token => {
        const title = token.title || token.metadata?.title || '';
        const baseName = token.base_name || '';
        return DYNAMIC_NAMES.some(name => title.includes(name) || baseName.includes(name));
    });
    
    console.log(`🔄 Processing ${dynamicTokens.length} dynamic stamps...`);
    
    await supabase.from('stamp_instances').delete().neq('token_id', '');
    
    let inserted = 0;
    for (const token of dynamicTokens) {
        const ownerId = getOwnerId(token);
        if (!ownerId) continue;
        
        const { error } = await supabase.from('stamp_instances').insert({
            token_id: token.token_id,
            name: token.base_name || token.title?.replace('Postage Stamp - ', '') || token.title,
            owner_id: ownerId,
            image_url: token.image_url || token.metadata?.media,
            last_updated: new Date().toISOString()
        });
        
        if (!error) inserted++;
    }
    
    return inserted;
}

async function sendTelegramNotification(stampsStats, otherStats, totalTokens) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram credentials not set, skipping notification');
        return;
    }
    
    const message = `🏆 *Yupland Stamps Update* 🏆

📮 *МАРКИ (Postage + Dynamic):*
   📊 Всего: ${stampsStats.total.toLocaleString()}
   🔥 Сожжено: ${stampsStats.burned.toLocaleString()}
   👥 Держателей: ${stampsStats.holders.toLocaleString()}
   🏪 В Лавке: ${stampsStats.alchemy.toLocaleString()}

📦 *ПРОЧИЕ NFT (не марки):*
   📊 Всего: ${otherStats.total.toLocaleString()}
   🔥 Сожжено: ${otherStats.burned.toLocaleString()}
   👥 Держателей: ${otherStats.holders.toLocaleString()}
   🏪 В Лавке: ${otherStats.alchemy.toLocaleString()}

📊 *ВСЕГО NFT на контракте:*
   📊 Всего: ${totalTokens.toLocaleString()}

🕐 *Обновлено:* ${new Date().toLocaleString()}`;
    
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            })
        });
        console.log('✅ Telegram notification sent');
    } catch (err) {
        console.error('❌ Failed to send Telegram notification:', err);
    }
}

async function main() {
    console.log('🚀 Starting quick-update with split statistics...');
    const startTime = Date.now();
    
    try {
        console.log('📡 Fetching ALL tokens from Sendler API...');
        const allTokens = await fetchAllTokens();
        console.log(`✅ Fetched ${allTokens.length} total tokens`);
        
        // Разделяем на марки и не-марки
        const stamps = allTokens.filter(t => isStamp(t));
        const otherNFTs = allTokens.filter(t => !isStamp(t));
        
        console.log(`\n📊 SPLIT RESULT:`);
        console.log(`   📮 Stamps (marks): ${stamps.length}`);
        console.log(`   📦 Other NFTs: ${otherNFTs.length}`);
        
        // Расчет статистики
        const stampsStats = calculateStatsForTokens(stamps);
        const otherStats = calculateStatsForTokens(otherNFTs);
        
        console.log(`\n📮 STAMPS STATS:`);
        console.log(`   Total: ${stampsStats.total}`);
        console.log(`   Burned: ${stampsStats.burned}`);
        console.log(`   Holders: ${stampsStats.holders}`);
        console.log(`   Alchemy: ${stampsStats.alchemy}`);
        
        console.log(`\n📦 OTHER NFTS STATS:`);
        console.log(`   Total: ${otherStats.total}`);
        console.log(`   Burned: ${otherStats.burned}`);
        console.log(`   Holders: ${otherStats.holders}`);
        console.log(`   Alchemy: ${otherStats.alchemy}`);
        
        // Обновляем таблицы Supabase (только для марок)
        console.log('\n💾 Updating stamps table...');
        const updatedCount = await updateStampsTable(allTokens);
        console.log(`✅ Updated ${updatedCount} stamps`);
        
        console.log('🔄 Updating dynamic instances...');
        const dynamicInserted = await updateDynamicInstances(allTokens);
        console.log(`✅ Inserted ${dynamicInserted} dynamic instances`);
        
        // Отправляем уведомление с раздельной статистикой
        await sendTelegramNotification(stampsStats, otherStats, allTokens.length);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n✅ Update completed in ${duration}s`);
        
    } catch (err) {
        console.error('❌ Fatal error:', err);
        process.exit(1);
    }
}

main();
