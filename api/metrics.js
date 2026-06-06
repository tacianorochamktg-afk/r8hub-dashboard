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

    // Buscar todas as assinaturas
    const subscriptions = await stripe.subscriptions.list({
      limit: 100,
      status: 'active'
    });

    // Buscar clientes
    const customers = await stripe.customers.list({
      limit: 100
    });

    // Calcular métricas
    // Exclui assinaturas com cancelamento agendado (cancel_at_period_end=true),
    // alinhando com o cálculo de MRR do Stripe Dashboard.
    const billingSubs = subscriptions.data.filter(sub => !sub.cancel_at_period_end);
    const activeCustomers = billingSubs.length;

    let mrr = 0;
    let totalLTV = 0;
    let canceledLastMonth = 0;

    billingSubs.forEach(sub => {
      // Calcular MRR por assinatura
      if (sub.items.data[0]?.price) {
        const price = sub.items.data[0].price;
        if (price.recurring && price.recurring.interval === 'month') {
          mrr += (price.unit_amount || 0) / 100;
        }
      }
    });

    // Buscar cancelamentos do mês passado (aproximado)
    const monthAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    const canceledSubs = await stripe.subscriptions.list({
      status: 'canceled',
      created: { gte: monthAgo },
      limit: 100
    });

    canceledLastMonth = canceledSubs.data.length;

    // Calcular churn rate (%)
    const churnRate = activeCustomers > 0 
      ? (canceledLastMonth / (activeCustomers + canceledLastMonth)) * 100 
      : 0;

    // Calcular ticket médio
    const avgTicket = activeCustomers > 0 ? mrr / activeCustomers : 0;

    // Calcular LTV (assumindo 12 meses de retenção)
    const ltv = avgTicket > 0 && churnRate < 100 
      ? (avgTicket * 12) / (churnRate / 100 || 1)
      : avgTicket * 12;

    // Calcular receita YTD (esse ano até agora)
    const startOfYear = new Date();
    startOfYear.setMonth(0);
    startOfYear.setDate(1);
    startOfYear.setHours(0, 0, 0, 0);
    const startOfYearUnix = Math.floor(startOfYear.getTime() / 1000);

    const invoices = await stripe.invoices.list({
      created: { gte: startOfYearUnix },
      limit: 100
    });

    let revenueYtd = 0;
    invoices.data.forEach(inv => {
      if (inv.paid || inv.status === 'paid') {
        revenueYtd += (inv.total || 0) / 100;
      }
    });

    // Buscar transações recentes (charges)
    const charges = await stripe.charges.list({
      limit: 10
    });

    const transactions = charges.data.map(charge => ({
      description: charge.description || 'Cobrança Stripe',
      amount: charge.amount / 100,
      date: new Date(charge.created * 1000).toLocaleDateString('pt-BR'),
      status: charge.paid ? 'aprovada' : 'pendente'
    }));

    // Retornar métricas formatadas
    res.status(200).json({
      metrics: {
        mrr: `R$ ${mrr.toFixed(2).replace('.', ',')}`,
        activeCustomers: activeCustomers,
        churnRate: `${churnRate.toFixed(2).replace('.', ',')}`,
        avgTicket: `R$ ${avgTicket.toFixed(2).replace('.', ',')}`,
        ltv: `R$ ${Math.max(ltv, 0).toFixed(2).replace('.', ',')}`,
        revenueYtd: `R$ ${revenueYtd.toFixed(2).replace('.', ',')}`
      },
      transactions: transactions,
      lastUpdated: new Date().toISOString(),
      dataPoints: {
        activeSubscriptions: activeCustomers,
        canceledLastMonth: canceledLastMonth,
        totalCharges: charges.data.length
      }
    });

  } catch (error) {
    console.error('Erro ao buscar métricas:', error);
    
    let errorMessage = 'Erro ao buscar dados do Stripe';
    
    if (error.message.includes('Invalid API Key')) {
      errorMessage = 'Chave Stripe inválida. Verifique em Vercel → Environment Variables';
    } else if (error.message.includes('Stripe API')) {
      errorMessage = `Erro da API Stripe: ${error.message}`;
    }

    res.status(500).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
