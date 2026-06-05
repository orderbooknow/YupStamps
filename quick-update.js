// Импортируем только нужные части
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseKey) {
    console.error('❌ SUPABASE_SERVICE_KEY not set');
    process.exit(1);
}

// Создаём клиент с отключением realtime через подмену WebSocket
// Важно: передаём пустой объект в транспорте, чтобы не инициализировался WebSocket
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    realtime: { enabled: false }
});

// Чтобы реально отключить realtime — подменяем конструктор WebSocket
// Это хак, но работает
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = class MockWebSocket {
        constructor() {}
        close() {}
        send() {}
        addEventListener() {}
        removeEventListener() {}
    };
}

const API_URL = 'https://api.sendler.xyz/nft/list/yuplandshop.mintbase1.near?limit=1';

async function testUpdate() {
    console.log(`🚀 Test update at ${new Date().toISOString()}`);
    
    // 1. Проверяем API Сендлера
    console.log('📡 Checking Sendler API...');
    let apiData;
    try {
        const res = await fetch(API_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        apiData = await res.json();
        console.log(`✅ API responded, tokens: ${apiData.tokens?.length || 0}`);
    } catch (err) {
        console.error('❌ Sendler API error:', err.message);
        process.exit(1);
    }
    
    // 2. Проверяем подключение к Supabase
    console.log('📡 Checking Supabase...');
    const { data, error } = await supabase.from('stamps').select('base_name', { count: 'exact', head: true });
    if (error) {
        console.error('❌ Supabase connection error:', error.message);
        process.exit(1);
    }
    console.log(`✅ Supabase OK, stamps count: ${data?.length || 0}`);
    
    console.log('🎉 All checks passed! Ready for full update.');
}

testUpdate();
