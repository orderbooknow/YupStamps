const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_R0pbZnbuSEbkaCLHcZ_YhQ_J2ZRgIB8';
const API_KEY = 'pR7xQnL2mV9cYfK4uD8sTjH1wB5eZaCgX0oNiUyE6lA';

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

// ============================================================
// 🆕 ИСКЛЮЧАЕМЫЕ И СПЕЦИАЛЬНЫЕ КОШЕЛЬКИ
// ============================================================
const EXCLUDED_OWNERS = [
    'sendler-alchemy.near',    // Лавка
    'darai_collection.near',   // Раздача NFT
    'darai_duplo.near',        // Сжигание
    'intents.near',            // HotCraft
    'darai_portal.near'        // Портал
];

const SPECIAL_WALLETS = {
    'intents.near': 'На ХК',
    'darai_portal.near': 'На Портале',
    'darai_duplo.near': 'Сожжено',
    'sendler-alchemy.near': 'В лавке'
};

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ============================================================
// 2. ЗАГРУЗКА ВСЕХ ТОКЕНОВ ИЗ API
// ============================================================
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

// ============================================================
// 3. ОБНОВЛЕНИЕ ТАБЛИЦЫ stamps (ТОЛЬКО ВЛАДЕЛЬЦЫ)
// ============================================================
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

// ============================================================
// 4. ОБНОВЛЕНИЕ ТАБЛИЦЫ stamp_instances (ДИНАМИЧЕСКИЕ МАРКИ)
// ============================================================
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
// 5. СОХРАНЕНИЕ СНИМКА КОНТРАКТА (для движений)
// ============================================================
async function saveSnapshot(allTokens) {
    console.log('📸 Сохраняем снимок контракта...');
    
    const snapshots = allTokens.map(token => ({
        snapshot_date: new Date().toISOString(),
        token_id: token.token_id,
        owner_id: token.owner_id || null,
        name: token.title || token.name || 'Unknown',
        image_url: token.media || token.image_url || null
    }));
    
    const batchSize = 1000;
    let saved = 0;
    for (let i = 0; i < snapshots.length; i += batchSize) {
        const batch = snapshots.slice(i, i + batchSize);
        const { error } = await supabase
            .from('contract_snapshots')
            .insert(batch);
        if (error) {
            console.error('❌ Ошибка сохранения снимка:', error);
            return;
        }
        saved += batch.length;
        console.log(`✅ Сохранено ${saved}/${snapshots.length} записей снимка`);
    }
    console.log(`✅ Снимок сохранён (${snapshots.length} записей)`);
}

// ============================================================
// 6. СОХРАНЕНИЕ ПОЛНОЙ СТАТИСТИКИ
// ============================================================
async function saveFullContractStats(allTokens) {
    console.log('📊 Сохраняем полную статистику контракта...');
    
    const stats = {
        total: allTokens.length,
        holders: new Set(),
        burned: 0,
        shop: 0,
        onHotCraft: 0,
        onPortal: 0,
        collections: {},
        topHolders: {},
        movements: {}
    };
    
    // Собираем базовую статистику
    for (const token of allTokens) {
        const owner = token.owner_id;
        
        // Специальные кошельки
        if (owner === 'darai_duplo.near') stats.burned++;
        else if (owner === 'sendler-alchemy.near') stats.shop++;
        else if (owner === 'intents.near') stats.onHotCraft++;
        else if (owner === 'darai_portal.near') stats.onPortal++;
        else if (!EXCLUDED_OWNERS.includes(owner)) {
            // Только реальные холдеры
            stats.holders.add(owner);
            stats.topHolders[owner] = (stats.topHolders[owner] || 0) + 1;
        }
        
        const collection = token.collection || token.collection_name || 'unknown';
        stats.collections[collection] = (stats.collections[collection] || 0) + 1;
    }
    
    // ============================================================
    // СЧИТАЕМ ДВИЖЕНИЯ ИЗ СНИМКОВ
    // ============================================================
    console.log('🔄 Считаем движения из снимков...');
    
    const { data: allSnapshots, error: snapError } = await supabase
        .from('contract_snapshots')
        .select('*')
        .order('snapshot_date', { ascending: false });
    
    if (snapError) {
        console.error('❌ Ошибка загрузки снимков:', snapError);
    } else if (allSnapshots && allSnapshots.length > 0) {
        const dateMap = {};
        for (const s of allSnapshots) {
            const date = s.snapshot_date;
            if (!dateMap[date]) dateMap[date] = [];
            dateMap[date].push(s);
        }
        
        const dates = Object.keys(dateMap).sort().reverse();
        if (dates.length >= 2) {
            const prev = dateMap[dates[1]];
            const curr = dateMap[dates[0]];
            
            const prevOwners = {};
            const currOwners = {};
            
            for (const item of prev) {
                prevOwners[item.token_id] = item.owner_id;
            }
            for (const item of curr) {
                currOwners[item.token_id] = item.owner_id;
            }
            
            let movements = 0;
            const today = new Date().toISOString().split('T')[0];
            
            for (const [tokenId, owner] of Object.entries(currOwners)) {
                const prevOwner = prevOwners[tokenId];
                if (prevOwner && prevOwner !== owner) {
                    movements++;
                }
            }
            
            stats.movements[today] = movements;
            console.log(`🔄 Движений за сегодня: ${movements}`);
        } else {
            console.log('⚠️ Недостаточно снимков для подсчёта движений');
        }
    }
    
    const topHolders = Object.entries(stats.topHolders)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([address, count]) => ({ address, count }));
    
    // Сохраняем историю холдеров
    console.log('📋 Сохраняем историю холдеров...');
    
    const { data: prevTopData } = await supabase
        .from('holders_history')
        .select('address, count')
        .order('recorded_at', { ascending: false })
        .limit(100);
    
    const prevMap = {};
    if (prevTopData) {
        for (const item of prevTopData) {
            prevMap[item.address] = item.count;
        }
    }
    
    const holderHistory = topHolders.map((h, i) => ({
        recorded_at: new Date().toISOString(),
        rank: i + 1,
        address: h.address,
        count: h.count,
        previous_count: prevMap[h.address] || 0
    }));
    
    if (holderHistory.length > 0) {
        const batchSize = 100;
        let saved = 0;
        for (let i = 0; i < holderHistory.length; i += batchSize) {
            const batch = holderHistory.slice(i, i + batchSize);
            const { error } = await supabase
                .from('holders_history')
                .insert(batch);
            if (error) {
                console.error('❌ Ошибка сохранения истории холдеров:', error);
            } else {
                saved += batch.length;
            }
        }
        console.log(`✅ Сохранено ${saved} записей истории холдеров`);
    }
    
    // Сохраняем активность холдеров
    if (allSnapshots && allSnapshots.length > 0) {
        const dateMap = {};
        for (const s of allSnapshots) {
            const date = s.snapshot_date;
            if (!dateMap[date]) dateMap[date] = [];
            dateMap[date].push(s);
        }
        
        const dates = Object.keys(dateMap).sort().reverse();
        if (dates.length >= 2) {
            const prev = dateMap[dates[1]];
            const curr = dateMap[dates[0]];
            
            const prevMapActivity = {};
            const currMapActivity = {};
            for (const s of prev) prevMapActivity[s.token_id] = s.owner_id;
            for (const s of curr) currMapActivity[s.token_id] = s.owner_id;
            
            const activity = {};
            for (const [tokenId, owner] of Object.entries(currMapActivity)) {
                const prevOwner = prevMapActivity[tokenId];
                if (prevOwner && prevOwner !== owner) {
                    activity[owner] = (activity[owner] || 0) + 1;
                }
            }
            
            const activityData = Object.entries(activity)
                .map(([address, movements]) => ({
                    recorded_at: new Date().toISOString(),
                    address,
                    movements
                }))
                .sort((a, b) => b.movements - a.movements)
                .slice(0, 50);
            
            if (activityData.length > 0) {
                const { error } = await supabase
                    .from('holders_activity')
                    .insert(activityData);
                if (error) {
                    console.error('❌ Ошибка сохранения активности холдеров:', error);
                } else {
                    console.log(`✅ Сохранена активность ${activityData.length} холдеров`);
                }
            }
        }
    }
    
    // ============================================================
    // 🆕 СОХРАНЯЕМ ТОП-СЖИГАТЕЛЕЙ (КОМБО ДУПЛО)
    // ============================================================
    console.log('🔥 Сохраняем топ-сжигателей...');
    
    const burners = {};
    for (const token of allTokens) {
        if (token.owner_id === 'darai_duplo.near') {
            const prevOwner = token.previous_owner_id || 'unknown';
            burners[prevOwner] = (burners[prevOwner] || 0) + 1;
        }
    }
    
    const today = new Date().toISOString().split('T')[0];
    const topBurners = Object.entries(burners)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([address, count]) => ({ 
            date: today,
            address, 
            count 
        }));
    
    if (topBurners.length > 0) {
        const { error: burnersError } = await supabase
            .from('burners_history')
            .insert(topBurners);
        if (burnersError) {
            console.error('❌ Ошибка сохранения топ-сжигателей:', burnersError);
        } else {
            console.log(`✅ Сохранено ${topBurners.length} записей топ-сжигателей`);
        }
    } else {
        console.log('⚠️ Сжиганий за сегодня нет');
    }
    
    // ============================================================
    // СОХРАНЯЕМ СТАТИСТИКУ
    // ============================================================
    
    const { error: insertError } = await supabase
        .from('contract_stats')
        .insert({
            recorded_at: new Date().toISOString(),
            total_nft: stats.total,
            total_holders: stats.holders.size,
            collections: stats.collections,
            top_holders: topHolders,
            burned_count: stats.burned,
            shop_count: stats.shop,
            on_hotcraft: stats.onHotCraft,
            on_portal: stats.onPortal
        });
    
    if (insertError) {
        console.error('❌ Ошибка сохранения статистики:', insertError);
    } else {
        console.log(`✅ Сохранено: ${stats.total} NFT, ${stats.holders.size} холдеров`);
        console.log(`📊 На ХК: ${stats.onHotCraft}, На Портале: ${stats.onPortal}`);
    }
    
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
    
    // ============================================================
    // 🆕 СОХРАНЯЕМ ИСТОРИЮ С ДОБАВЛЕНИЕМ on_hotcraft И on_portal
    // ============================================================
    const { error: historyError } = await supabase
        .from('contract_stats_history')
        .insert({
            recorded_at: new Date().toISOString(),
            total_nft: stats.total,
            holders: stats.holders.size,
            burned: stats.burned,
            in_shop: stats.shop,
            movements: stats.movements[today] || 0,
            on_hotcraft: stats.onHotCraft,   // 👈 ДОБАВЛЕНО
            on_portal: stats.onPortal        // 👈 ДОБАВЛЕНО
        });
    
    if (historyError) {
        console.error('❌ Ошибка сохранения истории:', historyError);
    } else {
        console.log(`✅ Сохранена история за ${new Date().toISOString()}`);
        console.log(`📊 На ХК: ${stats.onHotCraft}, На Портале: ${stats.onPortal}`);
    }
}

// ============================================================
// 7. ОТПРАВКА В TELEGRAM (ОБНОВЛЁННОЕ СООБЩЕНИЕ)
// ============================================================
async function sendTelegramReport(allTokens, updatedCount, startTime) {
    const token = '8708530374:AAHhcWFtjLqXK_Yxl0qlCtYrwi0ORLcDHNQ';
    const chatIds = ['454371494', '724771751'];
    
    // Марки
    const stampTokens = allTokens.filter(t => 
        t.title?.includes('Postage Stamp') || DYNAMIC_NAMES.includes(t.title)
    );
    const stampHolders = new Set(stampTokens.map(t => t.owner_id).filter(Boolean));
    const stampBurned = stampTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const stampShop = stampTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;
    
    // Прочие NFT
    const otherTokens = allTokens.filter(t => 
        !t.title?.includes('Postage Stamp') && !DYNAMIC_NAMES.includes(t.title)
    );
    const otherHolders = new Set(otherTokens.map(t => t.owner_id).filter(Boolean));
    const otherBurned = otherTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const otherShop = otherTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;
    
    // Специальные кошельки (все NFT)
    const onHotCraft = allTokens.filter(t => t.owner_id === 'intents.near').length;
    const onPortal = allTokens.filter(t => t.owner_id === 'darai_portal.near').length;
    const totalBurned = allTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const totalShop = allTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;
    
    const dynamicCount = allTokens.filter(t => DYNAMIC_NAMES.includes(t.title)).length;
    
    const endTime = Date.now();
    const elapsed = ((endTime - startTime) / 1000).toFixed(1);
    
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
// 7. ЗАГРУЗКА ИСТОРИИ СЖИГАНИЙ
// ============================================================
async function loadBurnHistory() {
    console.log('🔥 Загружаем историю транзакций кошелька сжигания...');
    const url = `https://api.sendler.xyz/history/nft-user-history/?wallet_id=darai_duplo.near&limit=200`;
    
    try {
        const response = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        if (!data.items || data.items.length === 0) {
            console.log('⚠️ Нет истории транзакций');
            return;
        }
        
        let saved = 0;
        for (const tx of data.items) {
            const { error } = await supabase.from('burn_history').insert({
                from_address: tx.sender_id || tx.from || 'unknown',
                to_address: tx.receiver_id || tx.to || 'unknown',
                token_id: tx.token_id,
                timestamp: tx.block_timestamp || tx.timestamp || tx.created_at,
                type: tx.action_type || tx.type || 'unknown',
                method: tx.method || null,
                contract_id: tx.contract_id || null,
                title: tx.title || null,
                media: tx.media || null,
                called_by: tx.called_by || null,
                block_height: tx.block_height || null,
                receipt_id: tx.receipt_id || null,
                tx_hash: tx.tx_hash || null,
                memo: tx.memo || null,
                amount: tx.amount || null,
                ft_contract: tx.ft_contract || null,
                sale_type: tx.sale_type || null
            });
            if (!error) saved++;
        }
        console.log(`✅ Сохранено ${saved} записей истории транзакций`);
    } catch (error) {
        console.error('❌ Ошибка загрузки истории транзакций:', error);
    }
}

// ============================================================
// 8. ГЛАВНАЯ ФУНКЦИЯ
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
        await saveSnapshot(allTokens);
        await saveFullContractStats(allTokens);
        await loadBurnHistory();
        
        console.log('═'.repeat(50));
        console.log('🎉 ОБНОВЛЕНИЕ ЗАВЕРШЕНО!');
        console.log(`📅 ${new Date().toLocaleString('ru-RU')}`);
        
        await sendTelegramReport(allTokens, updatedCount, startTime);
        
    } catch (error) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error);
        process.exit(1);
    }
}

main().catch(console.error);
