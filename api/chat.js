export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE = 'Products';

  if (!ANTHROPIC_API_KEY) { res.status(500).json({ error: 'Anthropic API key not configured' }); return; }

  async function searchProducts(query) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return { error: 'Airtable not configured', products: [] };
    try {
      const terms = query.toLowerCase().split(' ').filter(t => t.length > 2).slice(0, 3);
      const searchFields = ['Product Name', 'Brand', 'Main Concerns', 'Key Ingredients', 'Skin Type Fit', 'Category'];
      const filterParts = [];
      terms.forEach(term => {
        searchFields.forEach(field => {
          filterParts.push(`SEARCH("${term}", LOWER({${field}}))`);
        });
      });
      const filterFormula = filterParts.length > 0 ? `OR(${filterParts.slice(0, 12).join(',')})` : 'TRUE()';
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?maxRecords=10&filterByFormula=${encodeURIComponent(filterFormula)}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' }
      });
      if (!response.ok) { const err = await response.text(); console.error('Airtable error:', err); return { error: 'Airtable query failed', products: [] }; }
      const data = await response.json();
      const products = (data.records || []).map(r => ({
        name: r.fields['Product Name'] || '',
        brand: r.fields['Brand'] || '',
        category: r.fields['Category'] || '',
        subcategory: r.fields['Subcategory'] || '',
        origin: r.fields['Origin Market'] || '',
        texture: r.fields['Texture'] || '',
        keyIngredients: r.fields['Key Ingredients'] || '',
        mainConcerns: r.fields['Main Concerns'] || '',
        skinTypeFit: r.fields['Skin Type Fit'] || '',
        fragranceFree: r.fields['Fragrance Free'] || '',
        pH: r.fields['pH'] || '',
        routineStep: r.fields['Routine Step'] || '',
        applicationZone: r.fields['Application Zone'] || '',
        availableUS: r.fields['Available US'] || '',
        availableKR: r.fields['Available KR'] || '',
        priceRange: r.fields['Price Range USD'] || '',
        buyUS: r.fields['Buy US'] || '',
        buyKR: r.fields['Buy KR'] || '',
        notes: r.fields['Notes'] || ''
      }));
      return { products };
    } catch (err) { console.error('Airtable fetch error:', err); return { error: err.message, products: [] }; }
  }

  const tools = [{
    name: 'search_products',
    description: 'Search the Skinca verified product database for skincare products. Use this whenever recommending products to match user skin concerns, ingredients needed, or product categories. Always search before recommending to use verified database products.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search terms combining skin concern + ingredient + category. Examples: "dry skin ceramide moisturizer", "PIE niacinamide serum Korea", "BHA exfoliant oily acne", "sunscreen SPF US lightweight"'
        }
      },
      required: ['query']
    }
  }];

  const { messages, system } = req.body;

  try {
    let currentMessages = [...messages];
    let finalResponse = null;
    let iterations = 0;

    while (iterations < 5) {
      iterations++;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 3000, system: system || '', tools, messages: currentMessages })
      });

      if (!response.ok) { const errText = await response.text(); res.status(response.status).json({ error: errText }); return; }
      const data = await response.json();

      if (data.stop_reason !== 'tool_use') { finalResponse = data; break; }

      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) { finalResponse = data; break; }

      currentMessages.push({ role: 'assistant', content: data.content });

      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === 'search_products') {
          const result = await searchProducts(toolUse.input.query);
          let resultText;
          if (result.products.length === 0) {
            resultText = `No products found in Skinca database for "${toolUse.input.query}". Recommend based on skincare knowledge, noting these are not from our verified database.`;
          } else {
            resultText = `Found ${result.products.length} verified products in Skinca database:\n\n` +
              result.products.map((p, i) =>
                `${i+1}. ${p.name} by ${p.brand} (${p.origin})\n   Category: ${p.category}\n   Ingredients: ${p.keyIngredients}\n   Concerns: ${p.mainConcerns}\n   Skin Type: ${p.skinTypeFit}\n   Texture: ${p.texture}\n   Fragrance Free: ${p.fragranceFree}\n   Step: ${p.routineStep} | Zone: ${p.applicationZone}\n   Available US: ${p.availableUS}\n   Price: ${p.priceRange}\n   Buy US: ${p.buyUS}\n   Notes: ${p.notes}`
              ).join('\n\n');
          }
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultText });
        }
      }
      currentMessages.push({ role: 'user', content: toolResults });
    }

    if (!finalResponse) { res.status(500).json({ error: 'No final response' }); return; }
    res.status(200).json(finalResponse);

  } catch (err) { console.error('Handler error:', err); res.status(500).json({ error: err.message }); }
}
