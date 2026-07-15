const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

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
    'Stamp (Golden Soon - 8 Lv)'   // 🆕 новая динамическая марка
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
    'Stamp (Golden Soon - 8 Lv)': 'Alchemist (8)'   // 🆕 новая группа
};

// 🆕 Карта "название → репутация/редкость/группа", восстановленная из твоего Excel-файла
// "Марки на 24.04.xlsx" (лист "По Алфавиту", 271 запись)
const GROUPS_MAP_PATH = path.join(__dirname, 'groups_mapping.json');
if (!fs.existsSync(GROUPS_MAP_PATH)) {
    console.error(`❌ Не найден файл ${GROUPS_MAP_PATH} — он должен лежать рядом со скриптом`);
    process.exit(1);
}
const groupsList = JSON.parse(fs.readFileSync(GROUPS_MAP_PATH, 'utf8'));
const groupsMap = new Map(groupsList.map(g => [g.name.trim().toLowerCase(), g]));
console.log(`📖 Загружена карта разметки: ${groupsMap.size} названий`);

// Извлекаем базовое название из title API (как в update-groups.js)
function extractBaseName(apiTitle) {
    if (!apiTitle) return null;
    let base = apiTitle.replace(/^Postage Stamp - /, '');
    base = base.replace(/\s*\((common|rare|legendary|epic|uncommon|unique|mystic)\)$/i, '');
    base = base.replace(/^- /, '').trim();
    return base;
}

// 🆕 "Сырое" название — убираем только префикс "Postage Stamp - ", суффикс редкости НЕ трогаем.
// Нужно, потому что часть строк в Excel хранит суффикс прямо в названии
// (например, "Hong Kong (rare)" вместо "Hong Kong").
function extractRawName(apiTitle) {
    if (!apiTitle) return null;
    let raw = apiTitle.replace(/^Postage Stamp - /, '');
    raw = raw.replace(/^- /, '').trim();
    return raw;
}

// 🆕 Ищем соответствие: сначала точно, потом с нормализацией дефисов/пробелов
// (в Excel встречаются варианты вроде "Sri-Lanka" вместо "Sri Lanka")
function normalizeForMatch(s) {
    return s.trim().toLowerCase().replace(/[-\s]+/g, ' ');
}

const groupsMapNormalized = new Map(groupsList.map(g => [normalizeForMatch(g.name), g]));

function lookupStampInfo(apiTitle) {
    const baseName = extractBaseName(apiTitle);
    if (baseName) {
        const info = groupsMap.get(baseName.trim().toLowerCase()) || groupsMapNormalized.get(normalizeForMatch(baseName));
        if (info) return { info, baseName };
    }
    const rawName = extractRawName(apiTitle);
    if (rawName && rawName.toLowerCase() !== (baseName || '').toLowerCase()) {
        const info = groupsMap.get(rawName.trim().toLowerCase()) || groupsMapNormalized.get(normalizeForMatch(rawName));
        if (info) return { info, baseName };
    }
    return { info: null, baseName };
}

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
// 2. ОБНОВЛЯЕМ ТАБЛИЦУ stamps (обычные марки) — ВСЕ поля сразу
// ============================================================
async function syncStaticStamps(allTokens) {
    console.log('📊 Синхронизируем обычные марки в stamps (разовый полный забор, с Excel-разметкой)...');
    // 🆕 На контракте лежат не только марки — фильтруем строго по названию,
    // как и было в оригинальном quick-update.js
    const staticTokens = allTokens.filter(t => t.title?.includes('Postage Stamp'));

    let matched = 0;
    const notFound = [];

    const rows = staticTokens.map(t => {
        const { info, baseName } = lookupStampInfo(t.title);
        if (info) matched++;
        else notFound.push({ token_id: t.token_id, title: t.title, base_name: baseName });

        return {
            token_id: t.token_id,
            owner_id: t.owner_id || null,
            title: t.title || t.name || 'Unknown',
            base_name: baseName,
            group_name: info ? info.group : null,
            rarity: info ? info.rarity : null,
            reputation: info ? info.reputation : null,
            image_url: t.media || t.image_url || null,
            last_updated: new Date().toISOString()
        };
    });

    console.log(`✅ Сопоставлено с Excel-разметкой: ${matched}/${rows.length}`);
    if (notFound.length > 0) {
        console.log(`⚠️ Не найдено соответствие для ${notFound.length} марок (первые 10):`);
        notFound.slice(0, 10).forEach(nf => console.log(`   - "${nf.title}" → базовое: "${nf.base_name}"`));
        fs.writeFileSync('not_found_stamps.json', JSON.stringify(notFound, null, 2));
        console.log('📁 Полный список сохранён в not_found_stamps.json (загрузится как artifact)');
    }

    const batchSize = 500;
    let saved = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const { error } = await supabase.from('stamps').upsert(batch, { onConflict: 'token_id' });
        if (error) console.error(`❌ Ошибка сохранения батча ${i}-${i + batch.length}:`, error.message);
        else saved += batch.length;
    }
    console.log(`✅ Синхронизировано ${saved}/${rows.length} записей stamps`);
    return { staticCount: rows.length, matched, notFound: notFound.length };
}

// ============================================================
// 3. ДИНАМИЧЕСКИЕ (алхимические) МАРКИ — stamp_instances + шаблонная строка в stamps
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
        `📮 Обычных марок: ${formatNumber(stats.staticCount)}\n` +
        `✨ Динамических (алхимических): ${formatNumber(stats.dynamicCount)}\n` +
        (stats.unclassifiedCount > 0 ? `❓ Не попало ни в марки, ни в динамические: ${formatNumber(stats.unclassifiedCount)}\n` : ``) +
        `\n` +
        `✅ Сопоставлено с Excel-разметкой: ${formatNumber(stats.matched)}/${formatNumber(stats.staticCount)}\n` +
        (stats.notFound > 0 ? `⚠️ Не найдено соответствие: ${formatNumber(stats.notFound)}\n\n` : `\n`) +
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
        // Группируем по title, чтобы не листать тысячи одинаковых строк
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

        fs.writeFileSync('unclassified_tokens.json', JSON.stringify(sorted, null, 2));
        console.log('   📁 Полный список сохранён в unclassified_tokens.json (загрузится как artifact)');
    }

    return unclassified.length;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
    const startTime = Date.now();
    console.log('🚀 Полное восстановление stamps + stamp_instances (без снимков/статистики)');
    const allTokens = await fetchAllTokens();
    console.log(`✅ Всего токенов получено: ${allTokens.length}`);

    const unclassifiedCount = findUnclassifiedTokens(allTokens);

    const staticStats = await syncStaticStamps(allTokens);
    const dynamicStats = await syncDynamicStamps(allTokens);

    await sendTelegramReport({
        totalTokens: allTokens.length,
        staticCount: staticStats.staticCount,
        matched: staticStats.matched,
        notFound: staticStats.notFound,
        dynamicCount: dynamicStats.dynamicCount,
        unclassifiedCount
    }, startTime);

    console.log('🎉 Готово!');
}

main().catch(err => {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', err);
    process.exit(1);
});
