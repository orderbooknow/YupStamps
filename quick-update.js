const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://obbujhdmegdgxzdtpbai.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseKey) {
    console.error('❌ SUPABASE_SERVICE_KEY not set');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const CONTRACT = 'yuplandshop.mintbase1.near';
const API_URL = `https://api.sendler.xyz/nft/list/${CONTRACT}`;

const EXCLUDED_OWNERS = ['sendler-alchemy.near'];
const BURNER_ACCOUNT = 'darai_duplo.near';
const ALCHEMY_ACCOUNT = 'sendler-alchemy.near';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Node.js 18+ уже имеет fetch, но для совместимости оставим
const fetchData = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
};

async function fetchAllTokens() {
    let allTokens = [];
    let offset = 0;
    const limit = 500;
    let hasMore = true;
    
    console.log('🔄 Loading tokens...');
    
    while (hasMore) {
        const url = `${API_URL}?limit=${limit}&offset=${offset}`;
        console.log(`📥 offset=${offset}...`);
        
        try {
            const data = await fetchData(url);
            
            if (!data.tokens || data.tokens.length === 0) {
                hasMore = false;
                break;
            }
            
            allTokens.push(...data.tokens);
            offset += limit;
            await sleep(500);
            
        } catch (error) {
            console.error('❌ Fetch error:', error.message);
            hasMore = false;
            break;
        }
    }
    
    console.log(`✅ Loaded ${allTokens.length} tokens`);
    return allTokens;
}

async function updateStampsTable(tokens) {
    console.log('📊 Updating stamps...');
    
    const stampMap = new Map();
    
    for (const token of tokens) {
        const baseName = token.metadata?.base_name || token.metadata?.title?.replace('Postage Stamp - ', '');
        if (!baseName) continue;
        
        if (!stampMap.has(baseName)) {
            stampMap.set(baseName, {
                token_id: token.token_id,
                base_name: baseName,
                title: token.metadata?.title || baseName,
                group_name: token.metadata?.group_name || null,
                rarity: token.metadata?.rarity || 'Common',
                image_url: token.metadata?.media ? token.metadata.media.replace('ipfs://', 'https://ipfs.io/ipfs/') : null,
                count: 0,
                burned: 0,
                alchemyCount: 0,
                instances: []
            });
        }
        
        const entry = stampMap.get(baseName);
        entry.count++;
        
        const owner = token.owner_id;
        
        if (!owner || owner === 'null' || owner === BURNER_ACCOUNT) {
            entry.burned++;
        } else if (owner === ALCHEMY_ACCOUNT) {
            entry.alchemyCount++;
        } else if (owner && !EXCLUDED_OWNERS.includes(owner)) {
            entry.instances.push(owner);
        }
    }
    
    const stampsArray = Array.from(stampMap.values());
    console.log(`📊 ${stampsArray.length} unique stamps`);
    
    let updated = 0;
    for (const stamp of stampsArray) {
        const uniqueInstances = [...new Set(stamp.instances)];
        
        const { error } = await supabase
            .from('stamps')
            .upsert({
                token_id: stamp.token_id,
                base_name: stamp.base_name,
                title: stamp.title,
                group_name: stamp.group_name,
                rarity: stamp.rarity,
                image_url: stamp.image_url,
                count: stamp.count,
                burned: stamp.burned,
                alchemyCount: stamp.alchemyCount,
                instances: uniqueInstances,
                updated_at: new Date().toISOString()
            }, { onConflict: 'base_name' });
        
        if (error) {
            console.error(`❌ Error ${stamp.base_name}:`, error.message);
        } else {
            updated++;
        }
    }
    
    console.log(`✅ Stamps updated: ${updated}/${stampsArray.length}`);
}

async function main() {
    console.log(`🚀 Starting update at ${new Date().toISOString()}`);
    
    try {
        const tokens = await fetchAllTokens();
        if (tokens.length === 0) {
            console.error('❌ No tokens loaded');
            process.exit(1);
        }
        await updateStampsTable(tokens);
        console.log('🎉 Update completed!');
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

main();
