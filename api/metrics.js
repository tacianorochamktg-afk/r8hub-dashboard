import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({
        error: 'STRIPE_SECRET_KEY não configurada no Vercel. Vá em Settings → Environment Variables e adicione sua chave.'
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        error: 'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas no Vercel.'
      });
    }

    // ─── 1. MRR E ACTIVE CUSTOMERS — Supabase como fonte de verdade ──────────
    // internal_stripe_metrics() não tem auth guard — chamável com service_role key.
    // Segurança garantida pelo Supabase: sem GRANT para public/anon/authenticated.
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: metricsRows, error: metricsErr } = await supabase.rpc('internal_stripe_metrics');
    if (metricsErr) throw new Error(`Supabase RPC error: ${metricsErr.message}`);

    const mrr             = parseFloat(Number(metricsRows[0].mrr_brl).toFixed(2));
    const mrrActivePaying = mrr;
    const activeCount     = Number(metricsRows[0].active_subscriptions);

    // ─── 2. FETCH SUBSCRIPTIONS DO STRIPE ────────────────────────────────────
    // activeSubs: usado para métricas de movimento (mrrNew) e contadores auxiliares.
    // mrr e activeCount vêm do Supabase acima — não do Stripe.
    const [activeSubs, pastDueSubs, trialingSubs] = await Promise.all([
      stripe.subscriptions.list({ limit: 100, status: 'active',   expand: ['data.items.data.price'] }),
      stripe.subscriptions.list({ limit: 100, status: 'past_due', expand: ['data.items.data.price'] }),
      stripe.subscriptions.list({ limit: 100, status: 'trialing', expand: ['data.items.data.price'] }),
    ]);

    const pastDueCount  = pastDueSubs.data.length;
    const trialingCount = trialingSubs.data.length;

    // ─── 3. MRR helper (apenas para métricas de movimento) ───────────────────
    function subToMonthlyAmount(sub) {
      let monthly = 0;
      for (const item of sub.items.data) {
        const price    = item.price;
        const qty      = item.quantity || 1;
        const amount   = (price.unit_amount || 0) / 100;
        const interval = price.recurring?.interval;
        if (!interval) continue;
        if (interval === 'month')     monthly += amount * qty;
        else if (interval === 'year') monthly += (amount / 12) * qty;
        else if (interval === 'week') monthly += (amount * 52 / 12) * qty;
        else if (interval === 'day')  monthly += (amount * 365 / 12) * qty;
      }
      return monthly;
    }

    // ─── 4. MRR MOVEMENT ─────────────────────────────────────────────────────
    const now        = new Date();
    const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const monthEnd   = Math.floor(now.getTime() / 1000);

    let mrrNew = 0;
    for (const sub of activeSubs.data) {
      if (sub.start_date >= monthStart && sub.start_date <= monthEnd) {
        mrrNew += subToMonthlyAmount(sub);
      }
    }

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

    const mrrExpansion   = 0;
    const mrrContraction = 0;

    // ─── 5. YTD REVENUE ──────────────────────────────────────────────────────
    const yearStart  = Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
    const chargesYTD = await stripe.charges.list({ limit: 100, created: { gte: yearStart } });
    const revenueYTD = chargesYTD.data
      .filter(c => c.status === 'succeeded' && !c.refunded)
      .reduce((sum, c) => sum + c.amount / 100, 0);

    // ─── 6. CHURN RATE ────────────────────────────────────────────────────────
    const totalAtStart = activeCount + canceledThisMonth.data.length;
    const churnRate    = totalAtStart > 0 ? (canceledThisMonth.data.length / totalAtStart) * 100 : 0;

    // ─── 7. LTV ───────────────────────────────────────────────────────────────
    const avgTicket = activeCount > 0 ? mrrActivePaying / activeCount : 0;
    const ltv       = churnRate > 0 ? avgTicket / (churnRate / 100) : avgTicket * 24;

    // ─── 8. TRIAL → PAID CONVERSION ──────────────────────────────────────────
    const totalEver      = activeCount + trialingCount;
    const conversionRate = totalEver > 0 ? (activeCount / totalEver) * 100 : 0;

    // ─── 9. RECENT TRANSACTIONS ──────────────────────────────────────────────
    const recentCharges = await stripe.paymentIntents.list({ limit: 10, expand: ['data.latest_charge'] });
    const transactions  = recentCharges.data
      .filter(c => c.status === 'succeeded')
      .slice(0, 5)
      .map(c => ({
        id:          c.id,
        amount:      c.amount / 100,
        currency:    c.currency.toUpperCase(),
        status:      c.status,
        created:     c.created,
        description: c.description || c.metadata?.produto || 'Pagamento',
      }));

    return res.status(200).json({
      mrr,
      mrrActivePaying,
      activeCustomers: activeCount,
      trialingCount,
      churnRate:       parseFloat(churnRate.toFixed(2)),
      avgTicket:       parseFloat(avgTicket.toFixed(2)),
      ltv:             parseFloat(ltv.toFixed(2)),
      revenueYTD:      parseFloat(revenueYTD.toFixed(2)),
      mrrMovement: {
        novo:         parseFloat(mrrNew.toFixed(2)),
        expansao:     parseFloat(mrrExpansion.toFixed(2)),
        contracao:    parseFloat(mrrContraction.toFixed(2)),
        cancelamento: parseFloat(mrrChurn.toFixed(2)),
      },
      conversionRate:  parseFloat(conversionRate.toFixed(1)),
      transactions,
      updatedAt:       new Date().toISOString(),
    });

  } catch (err) {
    console.error('Metrics API error:', err);
    return res.status(500).json({ error: err.message || 'Erro interno do servidor' });
  }
}
