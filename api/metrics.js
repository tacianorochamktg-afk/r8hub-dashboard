import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export default async function handler(req, res) {
  // Permitir CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({
        error: 'STRIPE_SECRET_KEY não configurada no Vercel. Vá em Settings → Environment Variables e adicione sua chave.'
      });
    }

    // ─── 1. FETCH SUBSCRIPTIONS ───────────────────────────────────────────
    // MRR = somente 'active'. Trialing buscado separado apenas para exibir contador.
    const [activeSubs, pastDueSubs, trialingSubs] = await Promise.all([
      stripe.subscriptions.list({ limit: 100, status: 'active',   expand: ['data.items.data.price'] }),
    stripe.subscriptions.list({ limit: 100, status: 'past_due', expand: ['data.items.data.price'] }),
      stripe.subscriptions.list({ limit: 100, status: 'trialing', expand: ['data.items.data.price'] }),
    ]);

    const activeCount   = activeSubs.data.length + pastDueSubs.data.length;
    const pastDueCount  = pastDueSubs.data.length;
    const allSubs       = [...activeSubs.data, ...pastDueSubs.data, ...trialingSubs.data];
      const trialingCount = trialingSubs.data.length;

    // ─── 2. MRR helper ────────────────────────────────────────────────────
    // Stripe MRR = soma apenas de assinaturas 'active', normalizadas para mensal
    // Alinhado com o MRR exibido no Stripe Dashboard (status=active apenas)
    function subToMonthlyAmount(sub) {
      let monthly = 0;
      for (const item of sub.items.data) {
        const price    = item.price;
        const qty      = item.quantity || 1;
        const amount   = (price.unit_amount || 0) / 100; // cents → BRL
        const interval = price.recurring?.interval;
        if (!interval) continue;
        if (interval === 'month') {
          monthly += amount * qty;
        } else if (interval === 'year') {
          monthly += (amount / 12) * qty;
        } else if (interval === 'week') {
          monthly += (amount * 52 / 12) * qty;
        } else if (interval === 'day') {
          monthly += (amount * 365 / 12) * qty;
        }
      }
      return monthly;
    }

    // MRR = active only (Stripe: exclui trialing, past_due, canceled)
    const mrr = [...activeSubs.data, ...pastDueSubs.data].reduce((sum, sub) => sum + subToMonthlyAmount(sub), 0);

    // MRR from paying only (for ticket médio)
    const mrrActivePaying = [...activeSubs.data, ...pastDueSubs.data].reduce((sum, sub) => sum + subToMonthlyAmount(sub), 0);

    // ─── 3. TICKET MÉDIO ──────────────────────────────────────────────────
    // Ticket médio = MRR de pagantes / número de pagantes (igual ao Stripe)
    const avgTicket = activeCount > 0 ? mrrActivePaying / activeCount : 0;

    // ─── 4. MRR MOVEMENT (New / Expansion / Contraction / Churn) ─────────
    const now        = new Date();
    const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const monthEnd   = Math.floor(now.getTime() / 1000);

    // New MRR: subs started this month
    let mrrNew = 0;
    for (const sub of activeSubs.data) {
      if (sub.start_date >= monthStart && sub.start_date <= monthEnd) {
        mrrNew += subToMonthlyAmount(sub);
      }
    }

    // Churned MRR: canceled subs this month
    const canceledThisMonth = await stripe.subscriptions.list({
      limit: 100,
      status: 'canceled',
      created: { gte: monthStart },
      expand: ['data.items.data.price'],
    });
    let mrrChurn = 0;
    for (const sub of canceledThisMonth.data) {
      mrrChurn += subToMonthlyAmount(sub);
    }

    // Expansion / Contraction require webhook history — set to 0 as placeholder
    const mrrExpansion   = 0;
    const mrrContraction = 0;

    // ─── 5. YTD REVENUE ──────────────────────────────────────────────────
    const yearStart = Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
    // Use payment_intents or charges with status=succeeded for accurate revenue
    const chargesYTD = await stripe.charges.list({
      limit: 100,
      created: { gte: yearStart },
    });
    const revenueYTD = chargesYTD.data
      .filter(c => c.status === 'succeeded' && !c.refunded)
      .reduce((sum, c) => sum + c.amount / 100, 0);

    // ─── 6. CHURN RATE ────────────────────────────────────────────────────
    const totalAtStart = activeCount + canceledThisMonth.data.length;
    const churnRate    = totalAtStart > 0
      ? (canceledThisMonth.data.length / totalAtStart) * 100
      : 0;

    // ─── 7. LTV (PROJECTION) ─────────────────────────────────────────────
    const ltv = churnRate > 0 ? avgTicket / (churnRate / 100) : avgTicket * 24;

    // ─── 8. TRIAL → PAID CONVERSION ──────────────────────────────────────
    const totalEver      = activeCount + trialingCount;
    const conversionRate = totalEver > 0 ? (activeCount / totalEver) * 100 : 0;

    // ─── 9. RECENT TRANSACTIONS (succeeded only) ─────────────────────────
    const recentCharges = await stripe.charges.list({ limit: 10 });
    const transactions  = recentCharges.data
      .filter(c => c.status === 'succeeded')
      .slice(0, 5)
      .map(c => ({
        id:          c.id,
        amount:      c.amount / 100,
        currency:    c.currency.toUpperCase(),
        status:      c.status,
        created:     c.created,
        description: c.description || c.billing_details?.name || 'Pagamento',
      }));

    // ─── RESPONSE ─────────────────────────────────────────────────────────
    return res.status(200).json({
      mrr:             parseFloat(mrr.toFixed(2)),
      mrrActivePaying: parseFloat(mrrActivePaying.toFixed(2)),
      activeCustomers: activeCount,
      trialingCount,
      churnRate:       parseFloat(churnRate.toFixed(2)),
      avgTicket:       parseFloat(avgTicket.toFixed(2)),
      ltv:             parseFloat(ltv.toFixed(2)),
      revenueYTD:      parseFloat(revenueYTD.toFixed(2)),
      mrrMovement: {
        novo:          parseFloat(mrrNew.toFixed(2)),
        expansao:      parseFloat(mrrExpansion.toFixed(2)),
        contracao:     parseFloat(mrrContraction.toFixed(2)),
        cancelamento:  parseFloat(mrrChurn.toFixed(2)),
      },
      conversionRate:  parseFloat(conversionRate.toFixed(1)),
      transactions,
      updatedAt:       new Date().toISOString(),
    });

  } catch (err) {
    console.error('Metrics API error:', err);
    return res.status(500).json({
      error: err.message || 'Erro interno do servidor',
    });
  }
}
