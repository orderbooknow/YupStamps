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
// 1. ЗАБИРАЕМ ВСЕ ТОКЕНЫ С API (постранично, целиком, с повторными попытками)
// ============================================================
async function fetchPage(url, attempt = 1) {
    try {
        const response = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
        if (!response.ok) {
            if ([502, 503, 504].includes(response.status) && attempt < 5) {
                const delay = attempt * 2000;
                console.log(`⚠️ HTTP ${response.status} на странице, попытка ${attempt}, повтор через ${delay}мс...`);
                await sleep(delay);
                return fetchPage(url, attempt + 1);
            }
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (e) {
        if (attempt < 5 && (e.message?.includes('HTTP 502') || e.message?.includes('HTTP 503') || e.message?.includes('HTTP 504') || e.name === 'TypeError')) {
            const delay = attempt * 2000;
            console.log(`⚠️ Ошибка сети (${e.message}), попытка ${attempt}, повтор через ${delay}мс...`);
            await sleep(delay);
            return fetchPage(url, attempt + 1);
        }
        throw e;
    }
}

async function fetchAllTokens() {
    console.log('📥 Забираем все токены с API sendler...');
    let allTokens = [];
    let cursor = null;
    let page = 0;
    while (true) {
        let url = API_URL;
        if (cursor) url += `&cursor=${cursor}`;
        const data = await fetchPage(url);
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
    // 🆕 На контракте лежат не только марки — фильтруем строго по названию,
    // как и было в оригинальном quick-update.js
    const staticTokens = allTokens.filter(t => t.title?.includes('Postage Stamp'));

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

    // Одна "шаблонная" запись в stamps на каждое динамическое название.
    // 🆕 Используем синтетический token_id (а не base_name) — чтобы конфликт
    // разрешался через тот же полноценный уникальный индекс, что и у обычных марок.
    for (const name of DYNAMIC_NAMES) {
        const { error } = await supabase.from('stamps').upsert({
            token_id: `dynamic:${name}`,
            base_name: name,
            title: name,
            group_name: DYNAMIC_GROUPS[name],
            rarity: 'Legendary'
        }, { onConflict: 'token_id' });
        if (error) console.error(`❌ Ошибка upsert для ${name}: ${error.message}`);
        else console.log(`📝 Обновлена статическая запись для ${name}`);
    }

    return { dynamicCount: dynamicTokens.length };
}

// ============================================================
// ОТЧЁТ В TELEGRAM
// ============================================================
async function sendTelegramReport(allTokens, stats, startTime) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!token || chatIds.length === 0) {
        console.log('ℹ️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — отчёт в Telegram пропущен');
        return;
    }

    // Марки (обычные + динамические)
    const stampTokens = allTokens.filter(t => t.title?.includes('Postage Stamp') || DYNAMIC_NAMES.includes(t.title));
    const stampHolders = new Set(stampTokens.map(t => t.owner_id).filter(Boolean));
    const stampBurned = stampTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const stampShop = stampTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;

    // Прочие NFT на том же контракте (не марки)
    const otherTokens = allTokens.filter(t => !t.title?.includes('Postage Stamp') && !DYNAMIC_NAMES.includes(t.title));
    const otherHolders = new Set(otherTokens.map(t => t.owner_id).filter(Boolean));
    const otherBurned = otherTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const otherShop = otherTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;

    // Специальные кошельки (по всем NFT на контракте)
    const onHotCraft = allTokens.filter(t => t.owner_id === 'intents.near').length;
    const onPortal = allTokens.filter(t => t.owner_id === 'darai_portal.near').length;
    const totalBurned = allTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const totalShop = allTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const message =
        `🏆 <b>Yupland Stamps Update</b> 🏆\n\n` +

        `📮 <b>МАРКИ (Postage + Dynamic):</b>\n` +
        `   📊 Всего: ${formatNumber(stampTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(stampBurned)}\n` +
        `   👥 Держателей: ${formatNumber(stampHolders.size)}\n` +
        `   🏪 В Лавке: ${formatNumber(stampShop)}\n\n` +

        `📦 <b>ПРОЧИЕ NFT (не марки):</b>\n` +
        `   📊 Всего: ${formatNumber(otherTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(otherBurned)}\n` +
        `   👥 Держателей: ${formatNumber(otherHolders.size)}\n` +
        `   🏪 В Лавке: ${formatNumber(otherShop)}\n\n` +

        `📊 <b>ВСЕГО NFT на контракте:</b>\n` +
        `   📊 Всего: ${formatNumber(allTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(totalBurned)}\n` +
        `   🏪 В лавке: ${formatNumber(totalShop)}\n` +
        `   🏪 На ХК: ${formatNumber(onHotCraft)}\n` +
        `   🏪 На Портале: ${formatNumber(onPortal)}\n\n` +

        `🔄 Обновлено владельцев: ${formatNumber(stats.staticCount)}\n` +
        `✨ Динамических марок: ${formatNumber(stats.dynamicCount)}\n` +
        (stats.unclassifiedCount > 0 ? `❓ Не марки и не динамические: ${formatNumber(stats.unclassifiedCount)}\n\n` : `\n`) +
        `⏱️ Время: ${elapsed} сек`;

    for (const chatId of chatIds) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
            });
            const result = await res.json();
            if (result.ok) {
                console.log(`📨 Отправлено в Telegram (${chatId})`);
            } else {
                console.error(`❌ Telegram отклонил сообщение для ${chatId}: ${result.description || JSON.stringify(result)}`);
            }
        } catch (e) {
            console.error(`❌ Ошибка отправки для ${chatId}:`, e);
        }
    }
}

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ============================================================
// 🆕 ПРОВЕРКА: токены, не попавшие НИ под фильтр марок, НИ под динамические
// ============================================================
function findUnclassifiedTokens(allTokens) {
    const unclassified = allTokens.filter(t =>
        !t.title?.includes('Postage Stamp') && !DYNAMIC_NAMES.includes(t.title)
    );

    console.log(`🔎 Токенов, не попавших ни в марки, ни в динамические: ${unclassified.length}`);

    if (unclassified.length > 0) {
        const byTitle = {};
        unclassified.forEach(t => {
            const key = t.title || '(без названия)';
            byTitle[key] = (byTitle[key] || 0) + 1;
        });
        const sorted = Object.entries(byTitle).sort((a, b) => b[1] - a[1]);

        console.log('   Топ названий среди не попавших в обработку (первые 15):');
        sorted.slice(0, 15).forEach(([title, count]) => {
            console.log(`   - "${title}": ${count} шт.`);
        });
    }

    return unclassified.length;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
    const startTime = Date.now();
    console.log('🚀 Обновление владельцев (лёгкая, постоянная синхронизация)');
    const allTokens = await fetchAllTokens();
    console.log(`✅ Всего токенов получено: ${allTokens.length}`);

    const unclassifiedCount = findUnclassifiedTokens(allTokens);

    const staticStats = await syncOwners(allTokens);
    const dynamicStats = await syncDynamicStamps(allTokens);

    await sendTelegramReport(allTokens, {
        totalTokens: allTokens.length,
        staticCount: staticStats.staticCount,
        dynamicCount: dynamicStats.dynamicCount,
        unclassifiedCount
    }, startTime);

    console.log('🎉 Готово!');
}

main().catch(err => {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', err);
    process.exit(1);
});
