async function sendTelegramReport(allTokens, stats, startTime) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!token || chatIds.length === 0) {
        console.log('ℹ️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — отчёт в Telegram пропущен');
        return;
    }

    const stampTokens = allTokens.filter(t => t.title?.includes('Postage Stamp') || DYNAMIC_NAMES.includes(t.title));
    const stampHolders = new Set(stampTokens.map(t => t.owner_id).filter(Boolean));
    const stampBurned = stampTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const stampShop = stampTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;

    const totalHolders = new Set(allTokens.map(t => t.owner_id).filter(Boolean));
    const totalBurned = allTokens.filter(t => t.owner_id === 'darai_duplo.near').length;
    const totalShop = allTokens.filter(t => t.owner_id === 'sendler-alchemy.near').length;
    const onHotCraft = allTokens.filter(t => t.owner_id === 'intents.near').length;
    const onPortal = allTokens.filter(t => t.owner_id === 'darai_portal.near').length;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const message =
        `🏆 <b>Yupland Stamps Update</b> 🏆\n\n` +
        `📮 <b>МАРКИ (Postage + Dynamic):</b>\n` +
        `   📊 Всего: ${formatNumber(stampTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(stampBurned)}\n` +
        `   👥 Держателей: ${formatNumber(stampHolders.size)}\n` +
        `   🏪 В Лавке: ${formatNumber(stampShop)}\n` +
        `   🔄 Изменилось владельцев: ${formatNumber(stats.changedOwners || 0)}\n\n` +
        `📊 <b>ВСЕГО NFT на контракте:</b>\n` +
        `   📊 Всего: ${formatNumber(allTokens.length)}\n` +
        `   🔥 Сожжено: ${formatNumber(totalBurned)}\n` +
        `   👥 Держателей: ${formatNumber(totalHolders.size)}\n` +
        `   🏪 В лавке: ${formatNumber(totalShop)}\n` +
        `   🏪 На ХК: ${formatNumber(onHotCraft)}\n` +
        `   🏪 На Портале: ${formatNumber(onPortal)}\n\n` +
        `✨ Динамических марок: ${formatNumber(stats.dynamicCount)}\n` +
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
