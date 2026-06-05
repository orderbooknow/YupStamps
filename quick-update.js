const supabaseUrl = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const sendlerApiKey = process.env.SENDLER_API_KEY;

if (!supabaseKey) {
    console.error('❌ SUPABASE_SERVICE_KEY not set');
    process.exit(1);
}

if (!sendlerApiKey) {
    console.error('❌ SENDLER_API_KEY not set');
    process.exit(1);
}

const supabaseRest = async (method, path, body = null) => {
    const url = `${supabaseUrl}/rest/v1/${path}`;
    const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
    };
    
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    
    const response = await fetch(url, options);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase error ${response.status}: ${text}`);
    }
    return response.json();
};

const API_URL = 'https://api.sendler.xyz/nft/list/yuplandshop.mintbase1.near?limit=1';

async function testUpdate() {
    console.log(`🚀 Test update at ${new Date().toISOString()}`);
    
    console.log('📡 Checking Sendler API...');
    let apiData;
    try {
        const res = await fetch(API_URL, {
            headers: {
                'X-API-Key': sendlerApiKey,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        apiData = await res.json();
        console.log(`✅ API responded, tokens: ${apiData.tokens?.length || 0}`);
    } catch (err) {
        console.error('❌ Sendler API error:', err.message);
        process.exit(1);
    }
    
    console.log('📡 Checking Supabase...');
    try {
        const data = await supabaseRest('GET', 'stamps?select=base_name&limit=1');
        console.log(`✅ Supabase OK, response length: ${data.length}`);
    } catch (err) {
        console.error('❌ Supabase connection error:', err.message);
        process.exit(1);
    }
    
    console.log('🎉 All checks passed! Ready for full update.');
}

testUpdate();
