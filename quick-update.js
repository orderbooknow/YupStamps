const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const SUPABASE_KEY = 'sb_publishable_R0pbZnbuSEbkaCLHcZ_YhQ_J2ZRgIB8';
const API_KEY = 'pR7xQnL2mV9cYfK4uD8sTjH1wB5eZaCgX0oNiUyE6lA';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: {
        transport: WebSocket
    }
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

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

async function fetchAllTokens() {
    console.log('🔄 Загрузка данных из API...');
    let allTokens = [], cursor = null, page = 0;
    while (true) {
        let url = API_URL;
        if (cursor) url += `&cursor=${cursor}`;
        const response = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        allTokens.push(...data.items);
        console.log(`📦 Страница ${++page}: загружено ${data.items.length}, всего ${allTokens.length}`);
        if (data.next_cursor) { cursor = data.next_cursor; await sleep(500); }
        else break;
    }
    return allTokens;
}

async function updateStampsIncremental(allTokens) {
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
    console.log(`📊 В таблице stamps: ${oldMap.size} записей`);
    
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
    console.log(`✅ Обновлено ${updated} записей, ошибок: ${errors}`);
    return updated;
}

async function updateDynamicStamps(allTokens) {
    const dynamicTokens = allTokens.filter(t => DYNAMIC_NAMES.includes(t.title));
    console.log(`📊 Динамических токенов: ${dynamicTokens.length}`);
    
    await supabase.from('stamp_instances').delete().neq('token_id', '');
    console.log('🧹 Таблица stamp_instances очищена');
    
    let added = 0;
    for (const token of dynamicTokens) {
        const { error } = await supabase.from('stamp_instances').insert({
            token_id: token.token_id,
            name: token.title,
            owner_id: token.owner_id,
            image_url: token.media,
            last_updated: new Date()
        });
        if (error) console.error(`❌ Ошибка добавления ${token.token_id}: ${error.message}`);
        else added++;
    }
    console.log(`✅ Добавлено ${added} динамических экземпляров`);
}

// ============================================================
// 🆕 СОХРАНЕНИЕ ПОЛНОЙ СТАТИСТИКИ С ДВИЖЕНИЯМИ
// ============================================================
async function saveFullContractStats(allTokens) {
    console.log('📊 Сохраняем полную статистику контракта...');
    
    const stats = {
        total: allTokens.length,
        holders: new Set(),
        burned: 0,
        shop: 0,
        collections: {},
        topHolders: {},
        movements: {} // { date: count }
    };
    
    // Собираем данные по движениям
    const ownerHistory = {};
    
    for (const token of allTokens) {
        // Холдеры
        if (token.owner_id) {
            stats.holders.add(token.owner_id);
            stats.topHolders[token.owner_id] = (stats.topHolders[token.owner_id] || 0) + 1;
        }
        
        // Сожжено
        if (token.owner_id === 'darai_duplo.near') {
            stats.burned++;
        }
        
        // В лавке
        if (token.owner_id === 'sendler-alchemy.near') {
            stats.shop++;
        }
        
        // Коллекции
        const collection = token.collection || token.collection_name || 'unknown';
        stats.collections[collection] = (stats.collections[collection] || 0) + 1;
        
        // История владельцев для движений
        const tokenId = token.token_id;
        if (!ownerHistory[tokenId]) ownerHistory[tokenId] = [];
        ownerHistory[tokenId].push({
            date: token.last_updated || token.created_at || new Date().toISOString(),
            owner: token.owner_id
        });
    }
    
    // Считаем движения по дням
    for (const [tokenId, history] of Object.entries(ownerHistory)) {
        // Сортируем по дате
        history.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        for (let i = 1; i < history.length; i++) {
            if (history[i].owner !== history[i-1].owner) {
                const date = new Date(history[i].date).toISOString().split('T')[0];
                stats.movements[date] = (stats.movements[date] || 0) + 1;
            }
        }
    }
    
    // Топ-100 холдеров
    const topHolders = Object.entries(stats.topHolders)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([address, count]) => ({ address, count }));
    
    // Сохраняем в contract_stats
    const { error: insertError } = await supabase
        .from('contract_stats')
        .insert({
            recorded_at: new Date().toISOString(),
            total_nft: stats.total,
            total_holders: stats.holders.size,
            collections: stats.collections,
            top_holders: topHolders,
            burned_count: stats.burned,
            shop_count: stats.shop
        });
    
    if (insertError) {
        console.error('❌ Ошибка сохранения статистики:', insertError);
    } else {
        console.log(`✅ Сохранено: ${stats.total} NFT, ${stats.holders.size} холдеров`);
    }
    
    // Сохраняем ежедневную статистику с движениями
    const today = new Date().toISOString().split('T')[0];
    const { error: dailyError } = await supabase
        .from('daily_contract_stats')
        .upsert({
            date: today,
            total_nft: stats.total,
            holders: stats.holders.size,
            burned: stats.burned,
            in_shop: stats.shop,
            movements: stats.movements[today] || 0
        }, { onConflict: 'date' });
    
    if (dailyError) {
        console.error('❌ Ошибка сохранения ежедневной статистики:', dailyError);
    } else {
        console.log(`✅ Сохранена ежедневная статистика за ${today}`);
        console.log(`🔄 Движений за сегодня: ${stats.movements[today] || 0}`);
    }

    const { error: historyError } = await supabase
        .from('contract_stats_history')
        .insert({
            recorded_at: new Date().toISOString(),
            total_nft: stats.total,
            holders: stats.holders.size,
            burned: stats.burned,
            in_shop: stats.shop,
            movements: stats.movements[today] || 0
        });

    if (historyError) {
        console.error('❌ Ошибка сохранения истории:', historyError);
    } else {
        console.log(`✅ Сохранена история за ${new Date().toISOString()}`);
    }
}

// ============================================================
// 🆕 ОТПРАВКА В TELEGRAM (ПОЛНОЕ СООБЩЕНИЕ)
// ============================================================
async function sendTelegramReport(stats, allTokens, dynamicCount, updatedCount, startTime) {
    const token = '8708530374:AAHhcWFtjLqXK_Yxl0qlCtYrwi0ORLcDHNQ';
    const chatIds = ['454371494', '724771751']; // Ярослав и ты
    
    const dynamicNames = [
        'Stamp (legendary - 1 Lv)',
        'Stamp (legendary - 2 Lv)',
        'Stamp (legendary - 3 Lv)',
        'Stamp (legendary - 4 Lv)',
        'Stamp (legendary - 5 Lv)',
        'Stamp (legendary - 6 Lv)',
        'Stamp (legendary - 7 Lv)',
        'Old stamp (legendary)'
    ];
    
    const dynamicTokens = allTokens.filter(t => dynamicNames.includes(t.title));
    const dynamicHolders = new Set(dynamicTokens.map(t => t.owner_id).filter(Boolean));
    
    const otherTokens = allTokens.filter(t => !dynamicNames.includes(t.title));
    const otherHolders = new Set(otherTokens.map(t => t.owner_id).filter(Boolean));
    
    const dynamicBurned = dynamicTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const dynamicShop = dynamicTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;
    const otherBurned = otherTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const otherShop = otherTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;
    
    const endTime = Date.now();
    const elapsed = ((endTime - startTime) / 1000).toFixed(1);
    
    const message = 
        `🏆 <b>Yupland Stamps Update</b> 🏆\n\n` +
        
        `📮 <b>МАРКИ (Postage + Dynamic):</b>\n` +
        `   📊 Всего: ${formatNumber(dynamicTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(dynamicBurned)}\n` +
        `   👥 Держателей: ${formatNumber(dynamicHolders.size)}\n` +
        `   🏪 В Лавке: ${formatNumber(dynamicShop)}\n\n` +
        
        `📦 <b>ПРОЧИЕ NFT (не марки):</b>\n` +
        `   📊 Всего: ${formatNumber(otherTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(otherBurned)}\n` +
        `   👥 Держателей: ${formatNumber(otherHolders.size)}\n` +
        `   🏪 В Лавке: ${formatNumber(otherShop)}\n\n` +
        
        `📊 <b>ВСЕГО NFT на контракте:</b>\n` +
        `   📊 Всего: ${formatNumber(allTokens.length)}\n\n` +
        
        `🔄 Обновлено владельцев: ${formatNumber(updatedCount)}\n` +
        `✨ Динамических марок: ${formatNumber(dynamicCount)}\n\n` +
        `⏱️ Время: ${elapsed} сек`;
    
    for (const chatId of chatIds) {
        try {
            const url = `https://api.telegram.org/bot${token}/sendMessage`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
            console.log(`📨 Отправлено в Telegram (${chatId})`);
        } catch (e) {
            console.error(`❌ Ошибка отправки для ${chatId}:`, e);
        }
    }
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ
// ============================================================
async function main() {
    console.log('🚀 ЗАПУСК ОБНОВЛЕНИЯ ДАННЫХ');
    console.log('═'.repeat(50));
    
    const startTime = Date.now();
    
    try {
        const allTokens = await fetchAllTokens();
        console.log(`\n📊 Всего токенов в API: ${allTokens.length}`);
        console.log('═'.repeat(50));
        
        const updatedCount = await updateStampsIncremental(allTokens);
        await updateDynamicStamps(allTokens);
        await saveFullContractStats(allTokens);
        
        const dynamicNames = [
            'Stamp (legendary - 1 Lv)',
            'Stamp (legendary - 2 Lv)',
            'Stamp (legendary - 3 Lv)',
            'Stamp (legendary - 4 Lv)',
            'Stamp (legendary - 5 Lv)',
            'Stamp (legendary - 6 Lv)',
            'Stamp (legendary - 7 Lv)',
            'Old stamp (legendary)'
        ];
        const dynamicCount = allTokens.filter(t => dynamicNames.includes(t.title)).length;
        
        console.log('═'.repeat(50));
        console.log('🎉 ОБНОВЛЕНИЕ ЗАВЕРШЕНО!');
        console.log(`📅 ${new Date().toLocaleString('ru-RU')}`);
        
        await sendTelegramReport(
            null,
            allTokens,
            dynamicCount,
            updatedCount,
            startTime
        );
        
    } catch (error) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error);
        process.exit(1);
    }
}

main().catch(console.error);
