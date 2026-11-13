/**
 * BarberApp - Veri Yönetim Katmanı (DataManager)
 * Veriler bulutta (Python/Flask REST API /api) ve PostgreSQL üzerinde tutulur; tüm cihazlar ortak veriyi görür.
 * Sunucudan gelen veriler bellekte önbelleklenir, istatistikler bu önbellekten hesaplanır.
 */

class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const DataManager = {
  API_URL: '/api',
  SESSION_KEY: 'barberapp_session',

  // === OTURUM (SESSION) ===
  session: null, // { token, role: 'admin'|'barber', user }
  cache: { barbers: [], services: [], expenses: [], payouts: [] },

  restoreSession() {
    try {
      const raw = localStorage.getItem(this.SESSION_KEY);
      this.session = raw ? JSON.parse(raw) : null;
    } catch {
      this.session = null;
    }
    return this.session;
  },

  _saveSession(session) {
    this.session = session;
    localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
  },

  logout() {
    this.session = null;
    this.cache = { barbers: [], services: [], expenses: [], payouts: [] };
    localStorage.removeItem(this.SESSION_KEY);
  },

  get role() {
    return this.session ? this.session.role : null;
  },

  get currentUser() {
    return this.session ? this.session.user : null;
  },

  // === API İSTEMCİSİ ===

  async _call(action, params = {}) {
    let response;
    try {
      response = await fetch(this.API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.session ? { authorization: `Bearer ${this.session.token}` } : {})
        },
        body: JSON.stringify({ action, ...params })
      });
    } catch {
      throw new ApiError('network', 0);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(data.error || 'generic', response.status);
    }
    return data;
  },

  // === KİMLİK DOĞRULAMA ===

  async login(username, password) {
    const result = await this._call('login', { username, password });
    this._saveSession(result);
    await this.refresh();
    return result;
  },

  async registerAdmin(shopName, username, password, masterKey) {
    const result = await this._call('registerAdmin', { shopName, username, password, masterKey });
    this._saveSession(result);
    await this.refresh();
    return result;
  },

  async addBarber(name, username, password, avatar, commissionRate = 50) {
    await this._call('addBarber', { name, username, password, avatar, commissionRate });
    await this.refresh();
  },

  async updateBarber(id, { name, username, password, avatar, commissionRate }) {
    await this._call('updateBarber', { id, name, username, password, avatar, commissionRate });
    await this.refresh();
  },

  /** Sunucudan güncel verileri çeker (yetkiye göre süzülmüş olarak) */
  async refresh() {
    const data = await this._call('getData');
    this.cache = {
      barbers: data.barbers || [],
      services: data.services || [],
      expenses: data.expenses || [],
      payouts: data.payouts || []
    };
    if (this.session && data.user) {
      this._saveSession({ ...this.session, user: data.user });
    }
    return this.cache;
  },

  // === YAZMA İŞLEMLERİ ===

  async addService(amount, paymentMethod, note = '', tip = 0) {
    await this._call('addService', { amount, tip, paymentMethod, note });
    await this.refresh();
  },

  async updateService(id, { amount, tip = 0, paymentMethod, note = '' }) {
    const service = this.cache.services.find(s => s.id === id);
    if (!service) return;
    await this._call('updateService', {
      id,
      barberId: service.barberId,
      timestamp: service.timestamp,
      amount,
      tip,
      paymentMethod,
      note
    });
    await this.refresh();
  },

  async deleteService(id) {
    const service = this.cache.services.find(s => s.id === id);
    if (!service) return;
    await this._call('deleteService', { id, barberId: service.barberId, timestamp: service.timestamp });
    await this.refresh();
  },

  async addExpense(category, amount, description = '', paymentMethod = 'cash') {
    await this._call('addExpense', { category, amount, paymentMethod, description });
    await this.refresh();
  },

  async updateExpense(id, { category, amount, description = '', paymentMethod = 'cash' }) {
    const expense = this.cache.expenses.find(e => e.id === id);
    if (!expense) return;
    await this._call('updateExpense', {
      id,
      timestamp: expense.timestamp,
      category,
      amount,
      paymentMethod,
      description
    });
    await this.refresh();
  },

  async deleteExpense(id) {
    const expense = this.cache.expenses.find(e => e.id === id);
    if (!expense) return;
    await this._call('deleteExpense', { id, timestamp: expense.timestamp });
    await this.refresh();
  },

  async addPayout(barberId, amount, paymentMethod = 'cash', note = '') {
    await this._call('addPayout', { barberId, amount, paymentMethod, note });
    await this.refresh();
  },

  async deletePayout(id) {
    const payout = this.cache.payouts.find(p => p.id === id);
    if (!payout) return;
    await this._call('deletePayout', { id, timestamp: payout.timestamp });
    await this.refresh();
  },

  async deleteBarber(id) {
    await this._call('deleteBarber', { id });
    await this.refresh();
  },

  async changeAdminPassword(password) {
    await this._call('changeAdminPassword', { password });
  },

  async resetPassword(username, masterKey, newPassword) {
    return await this._call('resetPassword', { username, masterKey, newPassword });
  },

  // === OKUMA (ÖNBELLEKTEN) ===

  getBarbers() {
    return this.cache.barbers;
  },

  getBarber(id) {
    return this.cache.barbers.find(b => b.id === id) || null;
  },

  getServiceById(id) {
    return this.cache.services.find(s => s.id === id) || null;
  },

  getExpenseById(id) {
    return this.cache.expenses.find(e => e.id === id) || null;
  },

  _filterByDate(items, filters) {
    let result = items;
    if (filters.startDate) {
      const start = new Date(filters.startDate).getTime();
      result = result.filter(i => new Date(i.timestamp).getTime() >= start);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate).getTime();
      result = result.filter(i => new Date(i.timestamp).getTime() <= end);
    }
    return result.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  },

  getServices(filters = {}) {
    let services = this.cache.services;
    if (filters.barberId) services = services.filter(s => s.barberId === filters.barberId);
    if (filters.paymentMethod) services = services.filter(s => s.paymentMethod === filters.paymentMethod);
    return this._filterByDate(services, filters);
  },

  getExpenses(filters = {}) {
    let expenses = this.cache.expenses;
    if (filters.category) expenses = expenses.filter(e => e.category === filters.category);
    if (filters.createdBy) expenses = expenses.filter(e => e.createdBy === filters.createdBy);
    return this._filterByDate(expenses, filters);
  },

  getPayouts(filters = {}) {
    let payouts = this.cache.payouts || [];
    if (filters.barberId) payouts = payouts.filter(p => p.barberId === filters.barberId);
    return this._filterByDate(payouts, filters);
  },

  // === TARİH YARDIMCILARI ===

  _parseRefDate(refDate) {
    if (!refDate) return new Date();
    if (refDate instanceof Date && !isNaN(refDate.getTime())) return new Date(refDate);
    if (typeof refDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(refDate)) {
      const [y, m, d] = refDate.split('-').map(Number);
      return new Date(y, m - 1, d, 12, 0, 0, 0);
    }
    const parsed = new Date(refDate);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  },

  getDateRange(period = 'all', refDate = null) {
    const base = this._parseRefDate(refDate);
    const y = base.getFullYear();
    const m = base.getMonth();
    const d = base.getDate();
    let start, end;

    switch (period) {
      case 'today':
      case 'day':
        start = new Date(y, m, d, 0, 0, 0, 0);
        end = new Date(y, m, d, 23, 59, 59, 999);
        break;
      case 'week': {
        const day = (base.getDay() + 6) % 7;
        start = new Date(y, m, d - day, 0, 0, 0, 0);
        end = new Date(y, m, d - day + 6, 23, 59, 59, 999);
        break;
      }
      case 'month':
        start = new Date(y, m, 1, 0, 0, 0, 0);
        end = new Date(y, m + 1, 0, 23, 59, 59, 999);
        break;
      case 'year':
        start = new Date(y, 0, 1, 0, 0, 0, 0);
        end = new Date(y, 11, 31, 23, 59, 59, 999);
        break;
      default:
        start = new Date(0);
        end = new Date(Date.now() + 60 * 1000);
    }
    return { start, end };
  },

  _rangeFilters(period, refDate = null) {
    const { start, end } = this.getDateRange(period, refDate);
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  },

  // === İSTATİSTİKLER ===

  _sumServices(services, defaultRate = 50) {
    let total = 0, cashTotal = 0, cardTotal = 0, barberShare = 0, tipTotal = 0;
    services.forEach(s => {
      const amount = Number(s.amount) || 0;
      const tip = Number(s.tip) || 0;
      total += amount;
      tipTotal += tip;
      if (s.paymentMethod === 'card') cardTotal += amount;
      else cashTotal += amount;
      const rate = s.commissionRate !== undefined ? Number(s.commissionRate) : defaultRate;
      barberShare += typeof s.barberShare === 'number' ? s.barberShare : (amount * rate) / 100;
    });
    const r = n => Math.round(n * 100) / 100;
    return {
      total: r(total),
      cashTotal: r(cashTotal),
      cardTotal: r(cardTotal),
      barberShare: r(barberShare),
      tipTotal: r(tipTotal),
      serviceCount: services.length
    };
  },

  getBarberStats(barberId, period = 'all', refDate = null) {
    const barber = this.getBarber(barberId);
    const rate = barber && barber.commissionRate !== undefined ? Number(barber.commissionRate) : 50;
    const range = this._rangeFilters(period, refDate);
    const sums = this._sumServices(this.getServices({ barberId, ...range }), rate);
    const payouts = this.getPayouts({ barberId, ...range });
    const paidTotal = Math.round(payouts.reduce((acc, p) => acc + (Number(p.amount) || 0), 0) * 100) / 100;

    // Genel kalan maaş bakiyesi (tüm zamanlar hak ediş - tüm zamanlar yapılan ödeme)
    const allSums = this._sumServices(this.getServices({ barberId }), rate);
    const allPayouts = this.getPayouts({ barberId });
    const allPaid = Math.round(allPayouts.reduce((acc, p) => acc + (Number(p.amount) || 0), 0) * 100) / 100;
    const remainingSalary = Math.round((allSums.barberShare - allPaid) * 100) / 100;

    return {
      ...sums,
      commissionRate: rate,
      paidTotal,
      allPaidTotal: allPaid,
      remainingSalary
    };
  },

  getOverallStats(period = 'all', refDate = null, filterBarberId = null) {
    const range = this._rangeFilters(period, refDate);
    const services = this.getServices(filterBarberId ? { ...range, barberId: filterBarberId } : range);
    const expenses = this.getExpenses(filterBarberId ? { ...range, createdBy: filterBarberId } : range);
    const payouts = this.getPayouts(filterBarberId ? { ...range, barberId: filterBarberId } : range);

    const sums = this._sumServices(services);
    const totalExpenses = Math.round(expenses.reduce((acc, e) => acc + (Number(e.amount) || 0), 0) * 100) / 100;
    const cashExpenses = Math.round(
      expenses.filter(e => e.paymentMethod !== 'card').reduce((acc, e) => acc + (Number(e.amount) || 0), 0) * 100
    ) / 100;

    const totalPayouts = Math.round(payouts.reduce((acc, p) => acc + (Number(p.amount) || 0), 0) * 100) / 100;
    const cashPayouts = Math.round(
      payouts.filter(p => p.paymentMethod !== 'card').reduce((acc, p) => acc + (Number(p.amount) || 0), 0) * 100
    ) / 100;

    // Kasadaki Net Nakit = Nakit Hizmet Girişleri - Nakit Giderler - Nakit Maaş/Avans Ödemeleri
    const netCash = Math.round((sums.cashTotal - cashExpenses - cashPayouts) * 100) / 100;

    const barberStats = this.getBarbers().map(barber => {
      const rate = barber.commissionRate !== undefined ? Number(barber.commissionRate) : 50;
      const bRangeServices = this.getServices({ ...range, barberId: barber.id });
      const s = this._sumServices(bRangeServices, rate);
      const bRangePayouts = this.getPayouts({ ...range, barberId: barber.id });
      const paidTotal = Math.round(bRangePayouts.reduce((acc, p) => acc + (Number(p.amount) || 0), 0) * 100) / 100;

      // Kümülatif kalan maaş alacağı
      const allS = this._sumServices(this.getServices({ barberId: barber.id }), rate);
      const allP = this.getPayouts({ barberId: barber.id });
      const allPaid = Math.round(allP.reduce((acc, p) => acc + (Number(p.amount) || 0), 0) * 100) / 100;
      const remainingSalary = Math.round((allS.barberShare - allPaid) * 100) / 100;

      return {
        barberId: barber.id,
        barberName: barber.name,
        commissionRate: rate,
        total: s.total,
        barberShare: s.barberShare,
        tipTotal: s.tipTotal,
        paidTotal,
        remainingSalary,
        serviceCount: s.serviceCount
      };
    });

    return {
      totalRevenue: sums.total,
      cashTotal: sums.cashTotal,
      cardTotal: sums.cardTotal,
      tipTotal: sums.tipTotal,
      totalExpenses,
      totalSalaries: sums.barberShare,
      totalPayouts,
      netCash,
      netProfit: Math.round((sums.total - sums.barberShare - totalExpenses) * 100) / 100,
      serviceCount: sums.serviceCount,
      barberStats
    };
  },

  // === YEDEKLEME ===

  exportData() {
    return JSON.stringify({
      app: 'BarberApp',
      version: '2.1',
      exportedAt: new Date().toISOString(),
      barbers: this.cache.barbers,
      services: this.getServices(),
      expenses: this.getExpenses(),
      payouts: this.getPayouts()
    }, null, 2);
  }
};

window.DataManager = DataManager;
window.ApiError = ApiError;
