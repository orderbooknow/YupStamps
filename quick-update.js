// Сохраняем снимок всех NFT
async function saveSnapshot(allTokens) {
    console.log('📸 Сохраняем снимок контракта...');
    
    const snapshots = allTokens.map(token => ({
        snapshot_date: new Date().toISOString(),
        token_id: token.token_id,
        owner_id: token.owner_id || null,
        name: token.title || token.name || 'Unknown',
        image_url: token.media || token.image_url || null
    }));
    
    // Разбиваем на пачки по 1000 записей
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
