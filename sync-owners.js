const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// ============================================================
// НАСТРОЙКИ — секреты берутся из переменных окружения GitHub Actions
// ============================================================
const SUPABASE_URL = 'https://rplputivoyxqqjxjkvgd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_KEY = process.env.SENDLER_API_KEY;

if (!SUPABASE_KEY) { console.error('❌ Не задан SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!API_KEY) { console.error('❌ Не задан SENDLER_API_KEY'); process.exit(1); }

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
    'Old stamp (legendary)',
    'Stamp (Golden Soon - 8 Lv)'
];

// Группы для динамических (алхимических) марок — как было в sync-dynamic-stamps.js
const DYNAMIC_GROUPS = {
    'Stamp (legendary - 1 Lv)': 'Alchemist (old-3)',
    'Stamp (legendary - 2 Lv)': 'Alchemist (old-3)',
    'Stamp (legendary - 3 Lv)': 'Alchemist (old-3)',
    'Stamp (legendary - 4 Lv)': 'Alchemist (4-5)',
    'Stamp (legendary - 5 Lv)': 'Alchemist (4-5)',
    'Stamp (legendary - 6 Lv)': 'Alchemist (6)',
    'Stamp (legendary - 7 Lv)': 'Alchemist (7)',
    'Old stamp (legendary)': 'Alchemist (old-3)',
    'Stamp (Golden Soon - 8 Lv)': 'Alchemist (8)'
};

// ============================================================
// 1. ЗАБИРАЕМ ВСЕ ТОКЕНЫ С API (постранично, целиком)
// ============================================================
async function fetchAllTokens() {
    console.log('📥 Забираем все токены с API sendler...');
    let allTokens = [];
    let cursor = null;
    let page = 0;
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

// ============================================================
// 2. ОБЫЧНЫЕ МАРКИ — набор закрыт (новые никогда не минтятся),
//    поэтому обновляем ТОЛЬКО owner_id, без Excel-разметки.
//    group_name/rarity/reputation были один раз проставлены
//    скриптом sync-stamps-full.js и больше не трогаются.
// ============================================================
async function syncOwners(allTokens) {
    console.log('📊 Обновляем владельцев обычных марок...');
    const staticTokens = allTokens.filter(t => !DYNAMIC_NAMES.includes(t.title));

    const rows = staticTokens.map(t => ({
        token_id: t.token_id,
        owner_id: t.owner_id || null,
        last_updated: new Date().toISOString()
    }));

    const batchSize = 500;
    let saved = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const { error } = await supabase.from('stamps').upsert(batch, { onConflict: 'token_id' });
        if (error) console.error(`❌ Ошибка обновления батча ${i}-${i + batch.length}:`, error.message);
        else saved += batch.length;
    }
    console.log(`✅ Обновлено владельцев: ${saved}/${rows.length}`);
    return { staticCount: rows.length };
}

// ============================================================
// 3. ДИНАМИЧЕСКИЕ (алхимические) МАРКИ — новые появляются постоянно,
//    тут своя логика: полностью пересобираем stamp_instances каждый раз.
// ============================================================
async function syncDynamicStamps(allTokens) {
    const dynamicTokens = allTokens.filter(t => DYNAMIC_NAMES.includes(t.title));
    console.log(`📊 Динамических токенов: ${dynamicTokens.length}`);

    await supabase.from('stamp_instances').delete().neq('token_id', '');
    console.log('🧹 Таблица stamp_instances очищена');

    const rows = dynamicTokens.map(t => ({
        token_id: t.token_id,
        name: t.title,
        owner_id: t.owner_id || null,
        image_url: t.media || t.image_url || null,
        last_updated: new Date().toISOString()
    }));

    const batchSize = 500;
    let saved = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const { error } = await supabase.from('stamp_instances').insert(batch);
        if (error) console.error(`❌ Ошибка сохранения батча ${i}-${i + batch.length}:`, error.message);
        else saved += batch.length;
    }
    console.log(`✅ Сохранено ${saved}/${rows.length} динамических экземпляров`);

    // Одна "шаблонная" запись в stamps на каждое динамическое название
    for (const name of DYNAMIC_NAMES) {
        const { error } = await supabase.from('stamps').upsert({
            base_name: name,
            title: name,
            group_name: DYNAMIC_GROUPS[name],
            rarity: 'Legendary'
        }, { onConflict: 'base_name' });
        if (error) console.error(`❌ Ошибка upsert для ${name}: ${error.message}`);
        else console.log(`📝 Обновлена статическая запись для ${name}`);
    }

    return { dynamicCount: dynamicTokens.length };
}

// ============================================================
// ОТЧЁТ В TELEGRAM
// ============================================================
async function sendTelegramReport(stats, startTime) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!token || chatIds.length === 0) {
        console.log('ℹ️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — отчёт в Telegram пропущен');
        return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const message =
        `🖼️ <b>YupStamps Gallery Sync</b> 🖼️\n\n` +
        `📊 Всего токенов с API: ${formatNumber(stats.totalTokens)}\n` +
        `📮 Обычных марок (обновлён владелец): ${formatNumber(stats.staticCount)}\n` +
        `✨ Динамических (алхимических): ${formatNumber(stats.dynamicCount)}\n\n` +
        `⏱️ Время: ${elapsed} сек`;

    for (const chatId of chatIds) {
        try {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
            });
            console.log(`📨 Отправлено в Telegram (${chatId})`);
        } catch (e) {
            console.error(`❌ Ошибка отправки для ${chatId}:`, e);
        }
    }
}

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ============================================================
// MAIN
// ============================================================
async function main() {
    const startTime = Date.now();
    console.log('🚀 Обновление владельцев (лёгкая, постоянная синхронизация)');
    const allTokens = await fetchAllTokens();
    console.log(`✅ Всего токенов получено: ${allTokens.length}`);

    const staticStats = await syncOwners(allTokens);
    const dynamicStats = await syncDynamicStamps(allTokens);

    await sendTelegramReport({
        totalTokens: allTokens.length,
        staticCount: staticStats.staticCount,
        dynamicCount: dynamicStats.dynamicCount
    }, startTime);

    console.log('🎉 Готово!');
}

main().catch(err => {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', err);
    process.exit(1);
});
