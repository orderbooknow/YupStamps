const fs = require('fs');

// ============================================================
// НАСТРОЙКИ
// ============================================================
const API_KEY = process.env.SENDLER_API_KEY;
if (!API_KEY) {
    console.error('❌ Не задан SENDLER_API_KEY');
    process.exit(1);
}

const API_URL = 'https://api.sendler.xyz/nft/list/?contract_address=yuplandshop.mintbase1.near&limit=10000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// 1. ЗАГРУЗКА ВСЕХ ТОКЕНОВ ИЗ API
// ============================================================
async function fetchAllTokens() {
    console.log('📥 Загружаем все токены с API Sendler...');
    let allTokens = [];
    let cursor = null;
    let page = 0;

    while (true) {
        let url = API_URL;
        if (cursor) url += `&cursor=${cursor}`;

        const response = await fetch(url, {
            headers: { 'X-API-Key': API_KEY }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        allTokens.push(...data.items);
        console.log(`📦 Страница ${++page}: загружено ${data.items.length}, всего ${allTokens.length}`);

        if (data.next_cursor) {
            cursor = data.next_cursor;
            await sleep(500);
        } else {
            break;
        }
    }

    return allTokens;
}

// ============================================================
// 2. ИЗВЛЕЧЕНИЕ УНИКАЛЬНЫХ НАЗВАНИЙ МАРОК ИЗ API
// ============================================================
function extractUniqueStampNames(allTokens) {
    const stampTokens = allTokens.filter(t => 
        t.title && t.title.includes('Postage Stamp')
    );

    console.log(`📊 Найдено марок: ${stampTokens.length}`);

    const names = stampTokens.map(t => {
        let name = t.title.replace(/^Postage Stamp - /, '').trim();
        return name;
    });

    const uniqueNames = [...new Set(names)].sort();
    console.log(`📊 Уникальных названий: ${uniqueNames.length}`);

    return uniqueNames;
}

// ============================================================
// 3. НОРМАЛИЗАЦИЯ НАЗВАНИЯ (убираем суффиксы для поиска)
// ============================================================
function normalizeName(name) {
    let normalized = name;
    // Убираем суффиксы редкости в скобках
    normalized = normalized.replace(/\s*\((common|rare|legendary|epic|uncommon|unique|mystic)\)$/i, '');
    // Убираем суффиксы golden/gold/platinum/platina
    normalized = normalized.replace(/\s+(golden|gold|platinum|platina)$/i, '');
    // Убираем суффиксы - Lv и т.д.
    normalized = normalized.replace(/\s*-\s*\d+Lv$/i, '');
    return normalized.trim().toLowerCase();
}

// ============================================================
// 4. ЗАГРУЗКА СТАРОГО groups_mapping.json
// ============================================================
function loadOldGroupsMapping() {
    const filePath = 'groups_mapping.json';
    if (!fs.existsSync(filePath)) {
        console.error(`❌ Файл ${filePath} не найден`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`📖 Загружено ${data.length} записей из ${filePath}`);
    return data;
}

// ============================================================
// 5. ПОСТРОЕНИЕ КАРТЫ ПОИСКА ПО СТАРОМУ ФАЙЛУ
// ============================================================
function buildSearchMap(oldGroups) {
    const map = new Map();
    oldGroups.forEach(item => {
        const normalized = normalizeName(item.name);
        // Если несколько записей с одинаковым нормализованным именем,
        // оставляем последнюю (или можно объединить, но пока так)
        if (!map.has(normalized)) {
            map.set(normalized, item);
        } else {
            // Если уже есть, проверяем, какая лучше подходит
            const existing = map.get(normalized);
            // Если у новой записи есть редкость, а у старой нет — заменяем
            if (item.rarity && !existing.rarity) {
                map.set(normalized, item);
            }
        }
    });
    console.log(`📊 Построена карта поиска: ${map.size} уникальных ключей`);
    return map;
}

// ============================================================
// 6. ГЕНЕРАЦИЯ НОВОГО groups_mapping.json
// ============================================================
function generateNewGroupsMapping(apiNames, searchMap) {
    const result = [];
    let found = 0;
    let notFound = 0;
    let partialFound = 0;

    apiNames.forEach(apiName => {
        const normalized = normalizeName(apiName);
        let matched = searchMap.get(normalized);

        // Если точного совпадения нет, ищем частичное
        if (!matched) {
            for (const [key, value] of searchMap) {
                if (key.includes(normalized) || normalized.includes(key)) {
                    matched = value;
                    partialFound++;
                    break;
                }
            }
        }

        if (matched) {
            result.push({
                name: apiName,
                reputation: matched.reputation,
                rarity: matched.rarity,
                group: matched.group
            });
            found++;
        } else {
            result.push({
                name: apiName,
                reputation: 0,
                rarity: 'Common',
                group: 'Без группы'
            });
            notFound++;
            console.log(`❌ Не найдено: "${apiName}" (нормализовано: "${normalized}")`);
        }
    });

    console.log(`\n✅ Найдено точных совпадений: ${found}`);
    console.log(`🔍 Найдено частичных совпадений: ${partialFound}`);
    console.log(`⚠️ Не найдено (репутация 0): ${notFound}`);

    return result;
}

// ============================================================
// 7. MAIN
// ============================================================
async function main() {
    try {
        console.log('🚀 Генерация groups_mapping.json из API');
        console.log('═'.repeat(50));

        const allTokens = await fetchAllTokens();
        console.log(`✅ Всего токенов: ${allTokens.length}`);

        const apiNames = extractUniqueStampNames(allTokens);
        console.log(`✅ Уникальных названий марок: ${apiNames.length}`);

        const oldGroups = loadOldGroupsMapping();
        const searchMap = buildSearchMap(oldGroups);

        const newGroups = generateNewGroupsMapping(apiNames, searchMap);

        // Сохраняем в файл
        const outputPath = 'groups_mapping_api.json';
        fs.writeFileSync(
            outputPath,
            JSON.stringify(newGroups, null, 2)
        );
        console.log(`📁 Файл ${outputPath} создан! (${newGroups.length} записей)`);

        // Показываем записи с репутацией 0
        const zeroReputation = newGroups.filter(item => item.reputation === 0);
        if (zeroReputation.length > 0) {
            console.log(`\n⚠️ Записей с репутацией 0: ${zeroReputation.length}`);
            console.log('📌 Первые 10:');
            zeroReputation.slice(0, 10).forEach(item => {
                console.log(`   - "${item.name}" → ${item.rarity}, ${item.group}`);
            });
        }

        console.log('\n🎉 Готово!');
        console.log(`📌 Переименуй ${outputPath} в groups_mapping.json`);
        console.log('📌 Проверь записи с репутацией 0 и заполни их вручную.');

    } catch (error) {
        console.error('❌ Ошибка:', error);
        process.exit(1);
    }
}

main();