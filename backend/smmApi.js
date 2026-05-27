// =============================================
// SMM PROVIDER API — Universal Integration
// Works with: EasySmmPanel, JustAnotherPanel, PerfectPanel,
//             SMMKings, SMMFollows, etc.
//             (All use same API standard)
// =============================================

const SMM_CONFIG = {
  url: process.env.SMM_API_URL || 'https://easysmmpanel.com/api/v2',
  key: process.env.SMM_API_KEY || 'YOUR_EASY_SMM_API_KEY_HERE',
};

// Generic API caller
async function smmCall(params) {
  try {
    const body = new URLSearchParams({ key: SMM_CONFIG.key, ...params });
    const res = await fetch(SMM_CONFIG.url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── 1. Place a new order ──────────────────────
// Returns: { success, provider_order_id }
async function placeOrder({ service_id, link, quantity, comments = null, usernames = null }) {
  const params = { action: 'add', service: service_id, link, quantity };
  if (comments) params.comments = comments;    // for comment services
  if (usernames) params.usernames = usernames; // for some services
  const result = await smmCall(params);
  if (!result.success) return result;
  return { success: true, provider_order_id: result.data.order };
}

// ── 2. Check single order status ─────────────
// Returns: { status, start_count, remains, charge }
async function checkOrderStatus(provider_order_id) {
  const result = await smmCall({ action: 'status', order: provider_order_id });
  if (!result.success) return result;
  return {
    success: true,
    status: result.data.status,       // Pending / In progress / Completed / Partial / Canceled
    start_count: result.data.start_count,
    remains: result.data.remains,
    charge: result.data.charge,
  };
}

// ── 3. Check multiple orders at once ─────────
// provider_order_ids: array of IDs
async function checkMultipleOrders(provider_order_ids) {
  const result = await smmCall({ action: 'status', orders: provider_order_ids.join(',') });
  if (!result.success) return result;
  return { success: true, orders: result.data };
}

// ── 4. Get provider balance ───────────────────
async function getProviderBalance() {
  const result = await smmCall({ action: 'balance' });
  if (!result.success) return result;
  return { success: true, balance: result.data.balance, currency: result.data.currency };
}

// ── 5. Get all available services from provider ──
async function getProviderServices() {
  const result = await smmCall({ action: 'services' });
  if (!result.success) return result;
  return { success: true, services: result.data };
}

// ── 6. Cancel an order ───────────────────────
async function cancelOrder(provider_order_id) {
  const result = await smmCall({ action: 'cancel', orders: provider_order_id });
  if (!result.success) return result;
  return { success: true };
}

// ── 7. Refill an order (if dropped) ──────────
async function refillOrder(provider_order_id) {
  const result = await smmCall({ action: 'refill', order: provider_order_id });
  if (!result.success) return result;
  return { success: true, refill_id: result.data.refill };
}

module.exports = {
  placeOrder,
  checkOrderStatus,
  checkMultipleOrders,
  getProviderBalance,
  getProviderServices,
  cancelOrder,
  refillOrder,
};
