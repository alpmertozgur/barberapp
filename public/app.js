/**
 * BarberApp - Berber Dükkanı Yönetim Sistemi
 * Ana Uygulama Mantığı (app.js)
 */

const App = {
  currentScreen: 'login',
  currentBarberPeriod: 'today',
  currentAdminPeriod: 'today',
  currentBarberDate: '',
  currentAdminDate: '',
  selectedPaymentMethod: 'cash',
  selectedPayoutMethod: 'cash',
  selectedExpenseCategory: 'rent',
  selectedAvatar: '💇‍♂️',
  editingBarberId: null,
  editingServiceId: null,
  editingExpenseId: null,
  selectedAdminBarberId: null,
  confirmCallback: null,
  toastTimeout: null,
  busy: false,

  // === BAŞLATMA ===

  async init() {
    const today = this.todayYMD();
    this.currentBarberDate = today;
    this.currentAdminDate = today;

    I18N.init();
    this.bindEvents();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Kayıtlı oturum varsa otomatik giriş
    if (DataManager.restoreSession()) {
      await this.run(async () => {
        await DataManager.refresh();
        this.openHome();
      }, { silentAuthFail: true });
    }

    // Uygulamaya geri dönüldüğünde verileri tazele
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && DataManager.session && !this.busy) {
        DataManager.refresh().then(() => this.rerender()).catch(() => {});
      }
    });
  },

  // === YARDIMCILAR ===

  todayYMD() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  shiftDate(ymd, deltaDays) {
    const [y, m, d] = (ymd || this.todayYMD()).split('-').map(Number);
    const dt = new Date(y, m - 1, d + deltaDays, 12, 0, 0);
    const ny = dt.getFullYear();
    const nm = String(dt.getMonth() + 1).padStart(2, '0');
    const nd = String(dt.getDate()).padStart(2, '0');
    return `${ny}-${nm}-${nd}`;
  },

  formatCalendarLabel(ymd, period) {
    const [y, m, d] = (ymd || this.todayYMD()).split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    const loc = I18N.locale;

    if (period === 'week') {
      const { start, end } = DataManager.getDateRange('week', ymd);
      const sStr = start.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
      const eStr = end.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
      return `${sStr} – ${eStr}`;
    }
    if (period === 'month') {
      return dt.toLocaleDateString(loc, { month: 'long', year: 'numeric' });
    }
    if (period === 'year') {
      return String(y);
    }
    if (period === 'all') {
      return `${t('all')} (${dt.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' })})`;
    }
    const full = dt.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return ymd === this.todayYMD() ? `${t('today')} · ${full}` : full;
  },

  money(value) {
    return `${(Number(value) || 0).toLocaleString(I18N.locale, { maximumFractionDigits: 2 })} zł`;
  },

  escape(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  formatDate(iso) {
    const d = new Date(iso);
    const date = d.toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  },

  setLoading(on) {
    this.busy = on;
    document.getElementById('loading').classList.toggle('active', on);
  },

  /** Asenkron işlemi yükleniyor göstergesi ve hata yönetimiyle çalıştırır */
  async run(fn, { silentAuthFail = false } = {}) {
    if (this.busy) return;
    this.setLoading(true);
    try {
      return await fn();
    } catch (err) {
      const code = err && err.code ? err.code : 'generic';
      if (code === 'unauthorized') {
        DataManager.logout();
        this.showScreen('login');
        if (silentAuthFail) return;
      }
      const key = `err_${code}`;
      this.showToast(I18N.dict.tr[key] ? t(key) : t('err_generic'), 'error');
    } finally {
      this.setLoading(false);
    }
  },

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${screenId}`);
    if (target) {
      target.classList.add('active');
      window.scrollTo(0, 0);
    }
    this.currentScreen = screenId;
  },

  showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
  },

  openModal(id) {
    document.getElementById(id)?.classList.add('active');
  },

  closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
  },

  confirm(title, message, callback) {
    this.confirmCallback = callback;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    this.openModal('modal-confirm');
  },

  isAdmin() {
    return DataManager.role === 'admin';
  },

  openHome() {
    if (this.isAdmin()) this.openAdminDashboard();
    else this.openBarberDashboard();
  },

  rerender() {
    if (this.currentScreen === 'barber') this.renderBarberDashboard();
    if (this.currentScreen === 'admin') this.renderAdminDashboard();
  },

  // === GİRİŞ / KAYIT / ŞİFRE SIFIRLAMA ===

  async login() {
    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    const username = userEl.value.trim();
    const password = passEl.value;

    if (!username || !password) {
      this.showToast(t('needCreds'), 'error');
      return;
    }

    await this.run(async () => {
      const result = await DataManager.login(username, password);
      userEl.value = '';
      passEl.value = '';
      this.openHome();
      this.showToast(result.role === 'admin' ? t('welcomeAdmin') : t('welcomeBarber', { name: result.user.name }));
    });
  },

  openRegisterModal() {
    this.closeModal('modal-settings');
    this.editingBarberId = null;
    const titleEl = document.getElementById('register-modal-title');
    if (titleEl) {
      titleEl.dataset.i18n = 'registerTitle';
      titleEl.textContent = t('registerTitle');
    }
    document.getElementById('register-name').value = '';
    document.getElementById('register-username').value = '';
    document.getElementById('register-commission').value = '50';
    const passEl = document.getElementById('register-password');
    passEl.value = '';
    passEl.placeholder = t('regPasswordPh');
    this.selectedAvatar = '💇‍♂️';
    document.querySelectorAll('#register-avatar-grid .avatar-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.avatar === this.selectedAvatar);
    });
    this.openModal('modal-register');
    setTimeout(() => document.getElementById('register-name')?.focus(), 150);
  },

  openEditBarber(id, event) {
    if (event) event.stopPropagation();
    const barber = DataManager.getBarber(id);
    if (!barber) return;
    this.editingBarberId = id;
    const titleEl = document.getElementById('register-modal-title');
    if (titleEl) {
      titleEl.dataset.i18n = 'editBarberTitle';
      titleEl.textContent = t('editBarberTitle');
    }
    document.getElementById('register-name').value = barber.name || '';
    document.getElementById('register-username').value = barber.username || '';
    document.getElementById('register-commission').value =
      barber.commissionRate !== undefined ? barber.commissionRate : 50;
    const passEl = document.getElementById('register-password');
    passEl.value = '';
    passEl.placeholder = t('newPasswordOptionalPh');
    this.selectedAvatar = barber.avatar || '💇‍♂️';
    document.querySelectorAll('#register-avatar-grid .avatar-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.avatar === this.selectedAvatar);
    });
    this.openModal('modal-register');
    setTimeout(() => document.getElementById('register-name')?.focus(), 150);
  },

  async register() {
    const name = document.getElementById('register-name').value.trim();
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const rawRate = parseFloat(String(document.getElementById('register-commission').value).replace(',', '.'));
    const commissionRate = isNaN(rawRate) ? 50 : Math.min(100, Math.max(0, rawRate));

    if (!name || !username || (!this.editingBarberId && !password)) {
      this.showToast(t('fillAll'), 'error');
      return;
    }
    if (password && password.length < 4) {
      this.showToast(t('err_password_too_short'), 'error');
      return;
    }
    if (username.toLowerCase() === 'admin') {
      this.showToast(t('err_username_reserved'), 'error');
      return;
    }

    await this.run(async () => {
      if (this.editingBarberId) {
        await DataManager.updateBarber(this.editingBarberId, {
          name,
          username,
          password: password || undefined,
          avatar: this.selectedAvatar,
          commissionRate
        });
        this.editingBarberId = null;
        this.closeModal('modal-register');
        this.renderAdminDashboard();
        this.showToast(t('barberUpdated'));
      } else {
        await DataManager.addBarber(name, username, password, this.selectedAvatar, commissionRate);
        ['register-name', 'register-username', 'register-password'].forEach(id => (document.getElementById(id).value = ''));
        document.getElementById('register-commission').value = '50';
        this.closeModal('modal-register');
        this.renderAdminDashboard();
        this.showToast(t('registered', { name }));
      }
    });
  },

  async registerAdmin() {
    const shopName = document.getElementById('admin-reg-shop').value.trim();
    const username = document.getElementById('admin-reg-username').value.trim();
    const password = document.getElementById('admin-reg-password').value;
    const masterKey = document.getElementById('admin-reg-master-key').value.trim();

    if (!shopName || !username || !password || !masterKey) {
      this.showToast(t('fillAll'), 'error');
      return;
    }
    if (password.length < 4) {
      this.showToast(t('err_password_too_short'), 'error');
      return;
    }
    if (username.toLowerCase() === 'admin') {
      this.showToast(t('err_username_reserved'), 'error');
      return;
    }

    await this.run(async () => {
      await DataManager.registerAdmin(shopName, username, password, masterKey);
      ['admin-reg-shop', 'admin-reg-username', 'admin-reg-password', 'admin-reg-master-key'].forEach(
        id => (document.getElementById(id).value = '')
      );
      this.closeModal('modal-admin-register');
      this.openAdminDashboard();
      this.showToast(t('adminRegistered', { name: shopName }));
    });
  },

  async resetPassword() {
    const username = document.getElementById('forgot-username').value.trim();
    const masterKey = document.getElementById('forgot-master-key').value.trim();
    const newPassword = document.getElementById('forgot-new-password').value;

    if (!username || !masterKey || !newPassword) {
      this.showToast(t('fillAll'), 'error');
      return;
    }
    if (newPassword.length < 4) {
      this.showToast(t('err_password_too_short'), 'error');
      return;
    }

    await this.run(async () => {
      await DataManager.resetPassword(username, masterKey, newPassword);
      ['forgot-username', 'forgot-master-key', 'forgot-new-password'].forEach(
        id => (document.getElementById(id).value = '')
      );
      this.closeModal('modal-forgot-password');
      this.showToast(t('passwordResetSuccess'));
    });
  },

  logout() {
    this.selectedAdminBarberId = null;
    DataManager.logout();
    this.showScreen('login');
  },

  // === BERBER PANOSU ===

  openBarberDashboard() {
    this.renderBarberDashboard();
    this.showScreen('barber');
  },

  renderBarberDashboard() {
    const user = DataManager.currentUser;
    if (!user) return;
    const freshBarber = DataManager.getBarber(user.id) || user;
    document.getElementById('barber-header-name').textContent = `${freshBarber.avatar || ''} ${freshBarber.name}`.trim();

    const calInput = document.getElementById('barber-calendar-input');
    const calLabel = document.getElementById('barber-calendar-label');
    if (calInput) calInput.value = this.currentBarberDate;
    if (calLabel) calLabel.textContent = this.formatCalendarLabel(this.currentBarberDate, this.currentBarberPeriod);

    const stats = DataManager.getBarberStats(user.id, this.currentBarberPeriod, this.currentBarberDate);
    document.getElementById('barber-total').textContent = this.money(stats.total);
    document.getElementById('barber-share').textContent = this.money(stats.barberShare);
    const shareLabelEl = document.getElementById('barber-share-label');
    if (shareLabelEl) shareLabelEl.textContent = t('myShareRate', { rate: stats.commissionRate });
    document.getElementById('barber-cash').textContent = this.money(stats.cashTotal);
    document.getElementById('barber-card').textContent = this.money(stats.cardTotal);
    const remEl = document.getElementById('barber-remaining');
    if (remEl) remEl.textContent = this.money(stats.remainingSalary);
    const tipsEl = document.getElementById('barber-tips');
    if (tipsEl) tipsEl.textContent = this.money(stats.tipTotal);

    const range = DataManager._rangeFilters(this.currentBarberPeriod, this.currentBarberDate);
    const items = [
      ...DataManager.getServices({ barberId: user.id, ...range }).map(s => ({ ...s, type: 'service' })),
      ...DataManager.getExpenses({ createdBy: user.id, ...range }).map(e => ({ ...e, type: 'expense' })),
      ...DataManager.getPayouts({ barberId: user.id, ...range }).map(p => ({ ...p, type: 'payout' }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const list = document.getElementById('barber-services');
    list.innerHTML = items.length
      ? items
          .map(i =>
            i.type === 'service'
              ? this.renderServiceItem(i)
              : i.type === 'expense'
              ? this.renderExpenseItem(i)
              : this.renderPayoutItem(i, false)
          )
          .join('')
      : this.emptyState('✂️', t('noRecords'));
  },

  emptyState(icon, text) {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-text">${this.escape(text)}</div></div>`;
  },

  renderServiceItem(service, showBarberName = false) {
    const barber = DataManager.getBarber(service.barberId);
    const barberName = showBarberName ? ` · ${this.escape(barber?.name || t('deletedUser'))}` : '';
    const icon = service.paymentMethod === 'card' ? '💳' : '💵';
    const note = service.note ? ` · ${this.escape(service.note)}` : '';
    const tip = Number(service.tip) || 0;
    const tipBadge = tip > 0 ? `<span class="tip-badge">${this.escape(t('tipBadge', { amount: this.money(tip) }))}</span>` : '';

    return `
      <div class="service-item" data-id="${service.id}">
        <div class="service-icon ${service.paymentMethod}">${icon}</div>
        <div class="service-details">
          <div class="service-amount">${this.money(service.amount)}${tipBadge}</div>
          <div class="service-meta">${this.formatDate(service.timestamp)}${barberName}${note}</div>
        </div>
        <div class="service-share">
          <div class="service-share-value">${this.money(service.barberShare)}</div>
          <div class="service-share-label">${this.escape(t('shareLabel'))}</div>
        </div>
        <button class="service-edit" onclick="App.openEditService('${service.id}')" title="${this.escape(t('editBtn'))}">✏️</button>
        <button class="service-delete" onclick="App.deleteService('${service.id}')" title="${this.escape(t('delete'))}">✕</button>
      </div>`;
  },

  renderExpenseItem(expense, showCreator = false) {
    let creator = '';
    if (showCreator && expense.createdBy && expense.createdBy !== 'admin') {
      const b = DataManager.getBarber(expense.createdBy);
      creator = ` · ${this.escape(b?.name || t('deletedUser'))}`;
    }
    const desc = expense.description ? ` · ${this.escape(expense.description)}` : '';
    return `
      <div class="service-item expense-item" data-id="${expense.id}">
        <div class="service-icon expense">📤</div>
        <div class="service-details">
          <div class="service-amount" style="color: var(--red);">-${this.money(expense.amount)}</div>
          <div class="service-meta">${this.escape(t('cat_' + expense.category))} · ${this.formatDate(expense.timestamp)}${creator}${desc}</div>
        </div>
        <button class="service-edit" onclick="App.openEditExpense('${expense.id}')" title="${this.escape(t('editBtn'))}">✏️</button>
        <button class="service-delete" onclick="App.deleteExpense('${expense.id}')" title="${this.escape(t('delete'))}">✕</button>
      </div>`;
  },

  renderPayoutItem(payout, isAdminView = false) {
    const barber = DataManager.getBarber(payout.barberId);
    const barberName = isAdminView ? ` · ${this.escape(barber?.name || t('deletedUser'))}` : '';
    const payIcon = payout.paymentMethod === 'card' ? '💳' : '💵';
    const note = payout.note ? ` · ${this.escape(payout.note)}` : '';
    const delBtn = isAdminView
      ? `<button class="service-delete" onclick="App.deletePayout('${payout.id}')" title="${this.escape(t('delete'))}">✕</button>`
      : '';

    return `
      <div class="service-item payout-item" data-id="${payout.id}">
        <div class="service-icon payout">${payIcon}</div>
        <div class="service-details">
          <div class="service-amount" style="color: var(--gold-light);">-${this.money(payout.amount)}</div>
          <div class="service-meta">${this.escape(t('payoutItemLabel'))}${barberName} · ${this.formatDate(payout.timestamp)}${note}</div>
        </div>
        ${delBtn}
      </div>`;
  },

  getActiveCommissionRate() {
    if (this.editingServiceId) {
      const s = DataManager.getServiceById(this.editingServiceId);
      if (s && s.commissionRate !== undefined) return Number(s.commissionRate);
      const b = s ? DataManager.getBarber(s.barberId) : null;
      if (b && b.commissionRate !== undefined) return Number(b.commissionRate);
    }
    const u = DataManager.currentUser;
    if (u && u.id) {
      const b = DataManager.getBarber(u.id);
      if (b && b.commissionRate !== undefined) return Number(b.commissionRate);
    }
    return 50;
  },

  openAddService() {
    this.editingServiceId = null;
    const titleEl = document.getElementById('service-screen-title');
    if (titleEl) {
      titleEl.dataset.i18n = 'newService';
      titleEl.textContent = t('newService');
    }
    document.getElementById('service-amount').value = '';
    const tipEl = document.getElementById('service-tip');
    if (tipEl) tipEl.value = '';
    document.getElementById('service-note').value = '';
    document.getElementById('service-share-preview').textContent = this.money(0);
    this.setPaymentMethod('cash');
    this.showScreen('add-service');
    setTimeout(() => document.getElementById('service-amount').focus(), 150);
  },

  openEditService(id) {
    const s = DataManager.getServiceById(id);
    if (!s) return;
    this.editingServiceId = id;
    const titleEl = document.getElementById('service-screen-title');
    if (titleEl) {
      titleEl.dataset.i18n = 'editServiceTitle';
      titleEl.textContent = t('editServiceTitle');
    }
    document.getElementById('service-amount').value = s.amount;
    const tipEl = document.getElementById('service-tip');
    if (tipEl) tipEl.value = s.tip ? s.tip : '';
    document.getElementById('service-note').value = s.note || '';
    const rate = this.getActiveCommissionRate();
    document.getElementById('service-share-preview').textContent = this.money(Math.round(s.amount * rate) / 100);
    this.setPaymentMethod(s.paymentMethod || 'cash');
    this.showScreen('add-service');
    setTimeout(() => document.getElementById('service-amount').focus(), 150);
  },

  setPaymentMethod(method) {
    this.selectedPaymentMethod = method;
    document.getElementById('pay-cash').classList.toggle('active', method === 'cash');
    document.getElementById('pay-card').classList.toggle('active', method === 'card');
  },

  async saveService() {
    const amountInput = document.getElementById('service-amount');
    const amount = parseFloat(String(amountInput.value).replace(',', '.'));
    if (!amount || amount <= 0) {
      this.showToast(t('invalidAmount'), 'error');
      return;
    }
    const tipRaw = parseFloat(String(document.getElementById('service-tip')?.value || '').replace(',', '.'));
    const tip = isNaN(tipRaw) || tipRaw < 0 ? 0 : tipRaw;
    const note = document.getElementById('service-note').value;

    await this.run(async () => {
      if (this.editingServiceId) {
        await DataManager.updateService(this.editingServiceId, {
          amount,
          tip,
          paymentMethod: this.selectedPaymentMethod,
          note
        });
        this.editingServiceId = null;
        this.showToast(t('serviceUpdated'));
      } else {
        await DataManager.addService(amount, this.selectedPaymentMethod, note, tip);
        this.showToast(t('serviceSaved'));
      }
      this.openHome();
    });
  },

  // === YÖNETİCİ PANOSU ===

  openAdminDashboard() {
    this.renderAdminDashboard();
    this.showScreen('admin');
  },

  toggleBarberFilter(barberId) {
    if (this.selectedAdminBarberId === barberId) {
      this.selectedAdminBarberId = null;
    } else {
      this.selectedAdminBarberId = barberId;
    }
    this.renderAdminDashboard();
  },

  renderAdminDashboard() {
    const user = DataManager.currentUser;
    const headerTitle = document.getElementById('admin-header-title');
    if (headerTitle) {
      headerTitle.textContent = user && user.shopName ? `${t('adminPanel')} · ${user.shopName}` : t('adminPanel');
    }

    if (this.selectedAdminBarberId && !DataManager.getBarber(this.selectedAdminBarberId)) {
      this.selectedAdminBarberId = null;
    }

    const calInput = document.getElementById('admin-calendar-input');
    const calLabel = document.getElementById('admin-calendar-label');
    if (calInput) calInput.value = this.currentAdminDate;
    if (calLabel) calLabel.textContent = this.formatCalendarLabel(this.currentAdminDate, this.currentAdminPeriod);

    const stats = DataManager.getOverallStats(
      this.currentAdminPeriod,
      this.currentAdminDate,
      this.selectedAdminBarberId
    );
    document.getElementById('admin-revenue').textContent = this.money(stats.totalRevenue);
    document.getElementById('admin-cash').textContent = this.money(stats.cashTotal);
    document.getElementById('admin-card').textContent = this.money(stats.cardTotal);
    document.getElementById('admin-expenses').textContent = this.money(stats.totalExpenses);
    document.getElementById('admin-salaries').textContent = this.money(stats.totalSalaries);
    const netCashEl = document.getElementById('admin-net-cash');
    if (netCashEl) netCashEl.textContent = this.money(stats.netCash);
    document.getElementById('admin-profit').textContent = this.money(stats.netProfit);

    // Filtre bandı
    const filterBanner = document.getElementById('admin-filter-banner');
    const filterText = document.getElementById('admin-filter-text');
    if (filterBanner && filterText) {
      if (this.selectedAdminBarberId) {
        const fb = DataManager.getBarber(this.selectedAdminBarberId);
        filterText.textContent = t('filteredByBarber', { name: fb?.name || '' });
        filterBanner.style.display = 'flex';
      } else {
        filterBanner.style.display = 'none';
      }
    }

    // Berber performansı
    const perf = document.getElementById('admin-barber-perf');
    perf.innerHTML = stats.barberStats.length
      ? stats.barberStats
          .map(b => {
            const barber = DataManager.getBarber(b.barberId);
            const isSelected = this.selectedAdminBarberId === b.barberId;
            const tipStr = b.tipTotal > 0 ? ` · 💝 ${this.money(b.tipTotal)}` : '';
            return `
            <div class="barber-perf-item ${isSelected ? 'active-filter' : ''}" onclick="App.toggleBarberFilter('${b.barberId}')">
              <div class="barber-perf-avatar">${this.escape(barber?.avatar || '💈')}</div>
              <div class="barber-perf-info">
                <div class="barber-perf-name">${this.escape(b.barberName)} <span style="font-size:0.75rem;color:var(--gold-light);font-weight:600;">(%${b.commissionRate})</span></div>
                <div class="barber-perf-count">${this.escape(t('servicesCount', { n: b.serviceCount }))} · @${this.escape(barber?.username || '')}${tipStr}</div>
              </div>
              <div>
                <div class="barber-perf-amount">${this.money(b.total)}</div>
                <div class="barber-perf-salary">${this.escape(t('salary'))}: ${this.money(b.barberShare)}</div>
                <div class="barber-perf-remaining">${this.escape(t('remainingShort'))}: ${this.money(b.remainingSalary)}</div>
              </div>
              <div class="barber-actions">
                <button class="service-edit" onclick="App.openEditBarber('${b.barberId}', event)" title="${this.escape(t('editBtn'))}">✏️</button>
                <button class="service-delete" style="opacity: 1;" onclick="App.deleteBarber('${b.barberId}', event)" title="${this.escape(t('delete'))}">🗑️</button>
              </div>
            </div>`;
          })
          .join('')
      : this.emptyState('👥', t('noBarbers'));

    // Son işlemler (seçili çalışan varsa yalnızca o çalışanın işlemleri)
    const range = DataManager._rangeFilters(this.currentAdminPeriod, this.currentAdminDate);
    const fBarber = this.selectedAdminBarberId;
    const all = [
      ...DataManager.getServices(fBarber ? { ...range, barberId: fBarber } : range).map(s => ({ ...s, type: 'service' })),
      ...DataManager.getExpenses(fBarber ? { ...range, createdBy: fBarber } : range).map(e => ({ ...e, type: 'expense' })),
      ...DataManager.getPayouts(fBarber ? { ...range, barberId: fBarber } : range).map(p => ({ ...p, type: 'payout' }))
    ]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 100);

    document.getElementById('admin-transactions').innerHTML = all.length
      ? all
          .map(i =>
            i.type === 'service'
              ? this.renderServiceItem(i, true)
              : i.type === 'expense'
              ? this.renderExpenseItem(i, true)
              : this.renderPayoutItem(i, true)
          )
          .join('')
      : this.emptyState('📋', t('noTx'));
  },

  // === MAAŞ / AVANS ÖDEMELERİ (ADMIN) ===

  openPayoutModal(preselectBarberId = null) {
    if (!this.isAdmin()) return;
    const barbers = DataManager.getBarbers();
    if (!barbers.length) {
      this.showToast(t('noBarbers'), 'error');
      return;
    }
    const selectEl = document.getElementById('payout-barber');
    const targetId = preselectBarberId || this.selectedAdminBarberId || barbers[0].id;
    selectEl.innerHTML = barbers
      .map(b => {
        const bStats = DataManager.getBarberStats(b.id, 'all');
        return `<option value="${b.id}" ${b.id === targetId ? 'selected' : ''}>${this.escape(b.name)} (${this.escape(t('remainingShort'))}: ${this.money(bStats.remainingSalary)})</option>`;
      })
      .join('');
    document.getElementById('payout-amount').value = '';
    document.getElementById('payout-note').value = '';
    this.setPayoutPaymentMethod('cash');
    this.openModal('modal-payout');
    setTimeout(() => document.getElementById('payout-amount')?.focus(), 150);
  },

  setPayoutPaymentMethod(method) {
    this.selectedPayoutMethod = method;
    document.getElementById('payout-pay-cash')?.classList.toggle('active', method === 'cash');
    document.getElementById('payout-pay-card')?.classList.toggle('active', method === 'card');
  },

  async savePayout() {
    const barberId = document.getElementById('payout-barber').value;
    const amount = parseFloat(String(document.getElementById('payout-amount').value).replace(',', '.'));
    if (!barberId || !amount || amount <= 0) {
      this.showToast(t('invalidAmount'), 'error');
      return;
    }
    const note = document.getElementById('payout-note').value;

    await this.run(async () => {
      await DataManager.addPayout(barberId, amount, this.selectedPayoutMethod, note);
      this.closeModal('modal-payout');
      this.renderAdminDashboard();
      this.showToast(t('payoutSaved'));
    });
  },

  deletePayout(id) {
    this.confirm(t('deletePayoutTitle'), t('deletePayoutMsg'), () =>
      this.run(async () => {
        await DataManager.deletePayout(id);
        this.showToast(t('payoutDeleted'));
        this.rerender();
      })
    );
  },

  // === GİDERLER ===

  openAddExpense() {
    this.editingExpenseId = null;
    const admin = this.isAdmin();
    document.getElementById('expense-amount').value = '';
    document.getElementById('expense-description').value = '';
    // Çalışanlar yalnızca malzeme gideri ekleyebilir
    document.getElementById('expense-category-section').style.display = admin ? '' : 'none';
    const titleEl = document.getElementById('expense-header-title');
    titleEl.dataset.i18n = admin ? 'expenseTitle' : 'supplyExpenseTitle';
    titleEl.textContent = t(titleEl.dataset.i18n);
    this.setExpenseCategory(admin ? 'rent' : 'supplies');
    this.showScreen('add-expense');
    setTimeout(() => document.getElementById('expense-amount').focus(), 150);
  },

  openEditExpense(id) {
    const exp = DataManager.getExpenseById(id);
    if (!exp) return;
    this.editingExpenseId = id;
    const admin = this.isAdmin();
    document.getElementById('expense-category-section').style.display = admin ? '' : 'none';
    const titleEl = document.getElementById('expense-header-title');
    titleEl.dataset.i18n = 'editExpenseTitle';
    titleEl.textContent = t('editExpenseTitle');
    document.getElementById('expense-amount').value = exp.amount;
    document.getElementById('expense-description').value = exp.description || '';
    this.setExpenseCategory(admin ? exp.category || 'rent' : 'supplies');
    this.showScreen('add-expense');
    setTimeout(() => document.getElementById('expense-amount').focus(), 150);
  },

  setExpenseCategory(category) {
    this.selectedExpenseCategory = category;
    document.querySelectorAll('#expense-categories .category-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.category === category);
    });
  },

  async saveExpense() {
    const amountInput = document.getElementById('expense-amount');
    const amount = parseFloat(String(amountInput.value).replace(',', '.'));
    if (!amount || amount <= 0) {
      this.showToast(t('invalidAmount'), 'error');
      return;
    }
    const desc = document.getElementById('expense-description').value;
    const category = this.isAdmin() ? this.selectedExpenseCategory : 'supplies';

    await this.run(async () => {
      if (this.editingExpenseId) {
        await DataManager.updateExpense(this.editingExpenseId, { category, amount, description: desc });
        this.editingExpenseId = null;
        this.showToast(t('expenseUpdated'));
      } else {
        await DataManager.addExpense(category, amount, desc);
        this.showToast(t('expenseSaved'));
      }
      this.openHome();
    });
  },

  // === SİLME İŞLEMLERİ ===

  deleteService(id) {
    this.confirm(t('deleteServiceTitle'), t('deleteServiceMsg'), () =>
      this.run(async () => {
        await DataManager.deleteService(id);
        this.showToast(t('serviceDeleted'));
        this.rerender();
      })
    );
  },

  deleteExpense(id) {
    this.confirm(t('deleteExpenseTitle'), t('deleteExpenseMsg'), () =>
      this.run(async () => {
        await DataManager.deleteExpense(id);
        this.showToast(t('expenseDeleted'));
        this.rerender();
      })
    );
  },

  deleteBarber(id, event) {
    if (event) event.stopPropagation();
    const barber = DataManager.getBarber(id);
    this.confirm(t('deleteBarberTitle'), t('deleteBarberMsg', { name: barber?.name || '' }), () =>
      this.run(async () => {
        await DataManager.deleteBarber(id);
        if (this.selectedAdminBarberId === id) this.selectedAdminBarberId = null;
        this.showToast(t('barberDeleted'));
        this.rerender();
      })
    );
  },

  // === AYARLAR & PDF RAPOR ===

  async savePassword() {
    const input = document.getElementById('settings-new-password');
    const newPassword = input.value.trim();
    if (newPassword.length < 4) {
      this.showToast(t('err_password_too_short'), 'error');
      return;
    }
    await this.run(async () => {
      await DataManager.changeAdminPassword(newPassword);
      input.value = '';
      this.closeModal('modal-settings');
      this.showToast(t('passUpdated'));
    });
  },

  exportData() {
    const blob = new Blob([DataManager.exportData()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `barberapp-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast(t('exported'));
  },

  /**
   * Düzenli A4 PDF Rapor Üretici (Günlük, Aylık, Yıllık)
   * Türkçe, Lehçe ve Ukraynaca karakterleri %100 destekler.
   */
  downloadPdfReport(period) {
    const refDate = document.getElementById('report-date-input')?.value || this.currentAdminDate || this.todayYMD();
    const fBarber = this.selectedAdminBarberId;
    const stats = DataManager.getOverallStats(period, refDate, fBarber);
    const range = DataManager._rangeFilters(period, refDate);
    const txRows = [
      ...DataManager.getServices(fBarber ? { ...range, barberId: fBarber } : range).map(s => {
        const b = DataManager.getBarber(s.barberId);
        const tipPart = s.tip > 0 ? ` (+${this.money(s.tip)} tip)` : '';
        return {
          timestamp: s.timestamp,
          typeLabel: t('pdfServiceType'),
          isExpense: false,
          detail: `${b?.name || t('deletedUser')}${s.note ? ' - ' + s.note : ''}${tipPart}`,
          payment: s.paymentMethod === 'card' ? t('card') : t('cash'),
          amount: this.money(s.amount),
          share: this.money(s.barberShare)
        };
      }),
      ...DataManager.getExpenses(fBarber ? { ...range, createdBy: fBarber } : range).map(e => {
        const cleanCat = t('cat_' + e.category).replace(/^[^\s]+\s/, '');
        const b = e.createdBy && e.createdBy !== 'admin' ? DataManager.getBarber(e.createdBy) : null;
        return {
          timestamp: e.timestamp,
          typeLabel: t('pdfExpenseType'),
          isExpense: true,
          detail: `${cleanCat}${b ? ' (' + b.name + ')' : ''}${e.description ? ' - ' + e.description : ''}`,
          payment: '—',
          amount: `-${this.money(e.amount)}`,
          share: '—'
        };
      }),
      ...DataManager.getPayouts(fBarber ? { ...range, barberId: fBarber } : range).map(p => {
        const b = DataManager.getBarber(p.barberId);
        return {
          timestamp: p.timestamp,
          typeLabel: t('payoutItemLabel'),
          isExpense: true,
          detail: `${b?.name || t('deletedUser')}${p.note ? ' - ' + p.note : ''}`,
          payment: p.paymentMethod === 'card' ? t('card') : t('cash'),
          amount: `-${this.money(p.amount)}`,
          share: '—'
        };
      })
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const periodLabel =
      period === 'today' ? t('pdfPeriodDaily') : period === 'month' ? t('pdfPeriodMonthly') : t('pdfPeriodYearly');
    const dateRangeStr = this.formatCalendarLabel(refDate, period);
    const user = DataManager.currentUser;
    const filteredBarberObj = fBarber ? DataManager.getBarber(fBarber) : null;
    const shopTitle =
      user && user.shopName
        ? `BarberApp — ${user.shopName}${filteredBarberObj ? ' (' + filteredBarberObj.name + ')' : ''}`
        : `BarberApp${filteredBarberObj ? ' (' + filteredBarberObj.name + ')' : ''}`;

    // A4 @ 150 DPI: 1240 x 1754 px
    const W = 1240;
    const H = 1754;
    const canvases = [];

    const makePage = () => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      canvases.push({ canvas: c, ctx });
      return ctx;
    };

    const fitText = (ctx, text, maxW) => {
      let str = String(text ?? '');
      if (ctx.measureText(str).width <= maxW) return str;
      while (str.length > 1 && ctx.measureText(str + '…').width > maxW) {
        str = str.slice(0, -1);
      }
      return str + '…';
    };

    let ctx = makePage();

    // 1. Üst Başlık Bandı
    ctx.fillStyle = '#0f1018';
    ctx.fillRect(0, 0, W, 150);
    ctx.fillStyle = '#d4a54a';
    ctx.fillRect(0, 146, W, 6);

    ctx.fillStyle = '#d4a54a';
    ctx.font = 'bold 34px Inter, sans-serif';
    ctx.fillText(shopTitle, 60, 68);

    ctx.fillStyle = '#f0f0f5';
    ctx.font = '600 22px Inter, sans-serif';
    ctx.fillText(`${t('pdfReportTitle')} · ${periodLabel}`, 60, 112);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#e8c675';
    ctx.font = 'bold 22px Inter, sans-serif';
    ctx.fillText(dateRangeStr, W - 60, 72);
    ctx.fillStyle = '#a0a0b8';
    ctx.font = '16px Inter, sans-serif';
    ctx.fillText(new Date().toLocaleString(I18N.locale), W - 60, 110);
    ctx.textAlign = 'left';

    // 2. Özet Kartları (2 satır x 3 sütun)
    const cards = [
      { label: t('totalIncome'), value: this.money(stats.totalRevenue), color: '#b8862e', bg: '#fdf8ee' },
      { label: t('cash'), value: this.money(stats.cashTotal), color: '#059669', bg: '#ecfdf5' },
      { label: t('card'), value: this.money(stats.cardTotal), color: '#2563eb', bg: '#eff6ff' },
      { label: t('expenses'), value: this.money(stats.totalExpenses), color: '#dc2626', bg: '#fef2f2' },
      { label: t('salaries'), value: this.money(stats.totalSalaries), color: '#b8862e', bg: '#fdf8ee' },
      { label: t('netProfit'), value: this.money(stats.netProfit), color: '#059669', bg: '#ecfdf5' }
    ];

    const cardW = 356;
    const cardH = 104;
    const gap = 26;
    cards.forEach((card, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 60 + col * (cardW + gap);
      const y = 185 + row * (cardH + 18);

      ctx.fillStyle = card.bg;
      ctx.fillRect(x, y, cardW, cardH);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, cardW, cardH);
      ctx.fillStyle = card.color;
      ctx.fillRect(x, y, 6, cardH);

      ctx.fillStyle = '#475569';
      ctx.font = '600 17px Inter, sans-serif';
      ctx.fillText(card.label, x + 22, y + 36);

      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 28px Inter, sans-serif';
      ctx.fillText(card.value, x + 22, y + 78);
    });

    let y = 445;

    // 3. Berber Performansı Tablosu
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 20px Inter, sans-serif';
    ctx.fillText(t('barberPerf'), 60, y);
    y += 14;

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(60, y, W - 120, 42);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Inter, sans-serif';
    ctx.fillText(t('name'), 80, y + 27);
    ctx.fillText(t('newService'), 520, y + 27);
    ctx.fillText(t('barberTotal'), 760, y + 27);
    ctx.fillText(t('pdfShareCol'), 980, y + 27);
    y += 42;

    if (stats.barberStats.length === 0) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(60, y, W - 120, 42);
      ctx.fillStyle = '#64748b';
      ctx.font = '16px Inter, sans-serif';
      ctx.fillText(t('noBarbers'), 80, y + 27);
      y += 42;
    } else {
      stats.barberStats.forEach((b, idx) => {
        if (y > H - 140) {
          ctx = makePage();
          y = 70;
        }
        ctx.fillStyle = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
        ctx.fillRect(60, y, W - 120, 40);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.strokeRect(60, y, W - 120, 40);

        ctx.fillStyle = '#0f172a';
        ctx.font = '600 16px Inter, sans-serif';
        ctx.fillText(fitText(ctx, b.barberName, 410), 80, y + 26);
        ctx.fillStyle = '#475569';
        ctx.font = '16px Inter, sans-serif';
        ctx.fillText(t('servicesCount', { n: b.serviceCount }), 520, y + 26);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 16px Inter, sans-serif';
        ctx.fillText(this.money(b.total), 760, y + 26);
        ctx.fillStyle = '#059669';
        ctx.fillText(this.money(b.barberShare), 980, y + 26);
        y += 40;
      });
    }

    y += 38;

    // 4. İşlemler Tablosu
    const drawTxHeader = () => {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(60, y, W - 120, 42);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 15px Inter, sans-serif';
      ctx.fillText(t('pdfDateCol'), 76, y + 27);
      ctx.fillText(t('pdfTypeCol'), 270, y + 27);
      ctx.fillText(t('pdfDetailCol'), 395, y + 27);
      ctx.fillText(t('pdfPaymentCol'), 790, y + 27);
      ctx.fillText(t('pdfAmountCol'), 915, y + 27);
      ctx.fillText(t('pdfShareCol'), 1055, y + 27);
      y += 42;
    };

    if (y > H - 180) {
      ctx = makePage();
      y = 70;
    }

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 20px Inter, sans-serif';
    ctx.fillText(t('recentTx'), 60, y);
    y += 14;
    drawTxHeader();

    if (txRows.length === 0) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(60, y, W - 120, 44);
      ctx.fillStyle = '#64748b';
      ctx.font = '16px Inter, sans-serif';
      ctx.fillText(t('noTx'), 80, y + 28);
    } else {
      txRows.forEach((row, idx) => {
        if (y > H - 110) {
          ctx = makePage();
          y = 70;
          drawTxHeader();
        }
        ctx.fillStyle = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
        ctx.fillRect(60, y, W - 120, 38);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.strokeRect(60, y, W - 120, 38);

        ctx.fillStyle = '#334155';
        ctx.font = '15px Inter, sans-serif';
        ctx.fillText(this.formatDate(row.timestamp), 76, y + 25);

        ctx.fillStyle = row.isExpense ? '#dc2626' : '#059669';
        ctx.font = '600 15px Inter, sans-serif';
        ctx.fillText(row.typeLabel, 270, y + 25);

        ctx.fillStyle = '#0f172a';
        ctx.font = '15px Inter, sans-serif';
        ctx.fillText(fitText(ctx, row.detail, 375), 395, y + 25);

        ctx.fillStyle = '#475569';
        ctx.fillText(row.payment, 790, y + 25);

        ctx.fillStyle = row.isExpense ? '#dc2626' : '#0f172a';
        ctx.font = 'bold 15px Inter, sans-serif';
        ctx.fillText(row.amount, 915, y + 25);

        ctx.fillStyle = '#059669';
        ctx.font = '15px Inter, sans-serif';
        ctx.fillText(row.share, 1055, y + 25);
        y += 38;
      });
    }

    // Sayfa alt bilgisi (Sayfa No)
    const totalPages = canvases.length;
    canvases.forEach((p, idx) => {
      p.ctx.fillStyle = '#94a3b8';
      p.ctx.font = '15px Inter, sans-serif';
      p.ctx.textAlign = 'center';
      p.ctx.fillText(`${shopTitle}  ·  ${idx + 1} / ${totalPages}`, W / 2, H - 30);
      p.ctx.textAlign = 'left';
    });

    const pdfBlob = this._canvasesToPdfBlob(canvases.map(p => p.canvas));
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `barberapp-rapor-${period}-${refDate}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast(t('pdfDownloaded'));
  },

  /**
   * A4 Canvas dizisini standart çok sayfalı PDF 1.4 binary Blob'una dönüştürür
   */
  _canvasesToPdfBlob(canvases) {
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const offsets = [];

    const pushBytes = bytes => {
      chunks.push(bytes);
      offset += bytes.length;
    };
    const pushStr = str => pushBytes(enc.encode(str));
    const startObj = id => {
      offsets[id] = offset;
      pushStr(`${id} 0 obj\n`);
    };
    const endObj = () => pushStr('\nendobj\n');

    pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

    const pageCount = canvases.length;
    const pageIds = [];
    let nextId = 3;
    for (let i = 0; i < pageCount; i++) {
      pageIds.push({ pageId: nextId++, contentId: nextId++, imgId: nextId++ });
    }

    // 1: Catalog
    startObj(1);
    pushStr('<< /Type /Catalog /Pages 2 0 R >>');
    endObj();

    // 2: Pages
    startObj(2);
    pushStr(`<< /Type /Pages /Kids [${pageIds.map(p => `${p.pageId} 0 R`).join(' ')}] /Count ${pageCount} >>`);
    endObj();

    // A4 boyutu (pt): 595.28 x 841.89
    const pw = 595.28;
    const ph = 841.89;

    canvases.forEach((canvas, idx) => {
      const { pageId, contentId, imgId } = pageIds[idx];
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const binStr = atob(dataUrl.split(',')[1]);
      const imgBytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) imgBytes[i] = binStr.charCodeAt(i);

      startObj(pageId);
      pushStr(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      endObj();

      const contentStream = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
      startObj(contentId);
      pushStr(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`);
      endObj();

      startObj(imgId);
      pushStr(
        `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`
      );
      pushBytes(imgBytes);
      pushStr('\nendstream');
      endObj();
    });

    const xrefOffset = offset;
    const totalObjs = nextId;
    pushStr(`xref\n0 ${totalObjs}\n0000000000 65535 f \n`);
    for (let i = 1; i < totalObjs; i++) {
      pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    }
    pushStr(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

    return new Blob(chunks, { type: 'application/pdf' });
  },

  setLanguage(lang) {
    I18N.setLang(lang);
    this.rerender();
  },

  // === OLAY DİNLEYİCİLERİ ===

  bindEvents() {
    const on = (id, event, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, handler);
    };
    const onEnter = (id, handler) =>
      on(id, 'keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handler();
        }
      });

    // Dil seçimi
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setLanguage(btn.dataset.lang));
    });

    // Şifre Göster / Gizle Butonları
    document.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const isPass = input.type === 'password';
        input.type = isPass ? 'text' : 'password';
        btn.textContent = isPass ? '🙈' : '👁️';
        btn.classList.toggle('active', isPass);
      });
    });

    // Giriş
    on('btn-login', 'click', () => this.login());
    onEnter('login-username', () => document.getElementById('login-password').focus());
    onEnter('login-password', () => this.login());

    // Şifremi Unuttum (Kullanıcı adı + MASTER_KEY ile şifre sıfırlama)
    on('btn-show-forgot-password', 'click', () => {
      ['forgot-username', 'forgot-master-key', 'forgot-new-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      this.openModal('modal-forgot-password');
      setTimeout(() => document.getElementById('forgot-username')?.focus(), 150);
    });
    on('btn-submit-forgot', 'click', () => this.resetPassword());
    on('btn-cancel-forgot', 'click', () => this.closeModal('modal-forgot-password'));
    onEnter('forgot-new-password', () => this.resetPassword());

    // Çalışan Ekleme / Düzenleme (Yalnızca Admin Panelinden)
    on('btn-admin-add-barber', 'click', () => this.openRegisterModal());
    on('btn-submit-register', 'click', () => this.register());
    on('btn-cancel-register', 'click', () => {
      this.editingBarberId = null;
      this.closeModal('modal-register');
    });
    onEnter('register-password', () => this.register());

    // Maaş / Avans Ödemesi (Yalnızca Admin Panelinden)
    on('btn-add-payout', 'click', () => this.openPayoutModal());
    on('payout-pay-cash', 'click', () => this.setPayoutPaymentMethod('cash'));
    on('payout-pay-card', 'click', () => this.setPayoutPaymentMethod('card'));
    on('btn-submit-payout', 'click', () => this.savePayout());
    on('btn-cancel-payout', 'click', () => this.closeModal('modal-payout'));
    onEnter('payout-amount', () => this.savePayout());

    // Yönetici Çalışan Filtresi Temizleme
    on('btn-clear-barber-filter', 'click', () => {
      this.selectedAdminBarberId = null;
      this.renderAdminDashboard();
    });

    // Yeni Firma / Yönetici Kaydı (Ana ekrandan MASTER_KEY yetki şifresiyle)
    on('btn-show-admin-register', 'click', () => {
      this.openModal('modal-admin-register');
      setTimeout(() => document.getElementById('admin-reg-shop')?.focus(), 150);
    });
    on('btn-submit-admin-register', 'click', () => this.registerAdmin());
    on('btn-cancel-admin-register', 'click', () => this.closeModal('modal-admin-register'));
    onEnter('admin-reg-master-key', () => this.registerAdmin());
    on('register-avatar-grid', 'click', e => {
      const btn = e.target.closest('.avatar-btn');
      if (!btn) return;
      document.querySelectorAll('#register-avatar-grid .avatar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.selectedAvatar = btn.dataset.avatar;
    });

    // Çıkış ve geri butonları
    on('barber-back', 'click', () => this.logout());
    on('admin-back', 'click', () => this.logout());
    on('service-back', 'click', () => {
      this.editingServiceId = null;
      this.openHome();
    });
    on('expense-back', 'click', () => {
      this.editingExpenseId = null;
      this.openHome();
    });

    // Hizmet
    on('btn-add-service', 'click', () => this.openAddService());
    on('service-amount', 'input', e => {
      const val = parseFloat(String(e.target.value).replace(',', '.')) || 0;
      const rate = this.getActiveCommissionRate();
      document.getElementById('service-share-preview').textContent = this.money(Math.round(val * rate) / 100);
    });
    onEnter('service-amount', () => this.saveService());
    on('pay-cash', 'click', () => this.setPaymentMethod('cash'));
    on('pay-card', 'click', () => this.setPaymentMethod('card'));
    on('btn-save-service', 'click', () => this.saveService());

    // Gider
    on('btn-add-expense', 'click', () => this.openAddExpense());
    on('btn-add-supply', 'click', () => this.openAddExpense());
    on('expense-categories', 'click', e => {
      const btn = e.target.closest('.category-btn');
      if (btn) this.setExpenseCategory(btn.dataset.category);
    });
    on('btn-save-expense', 'click', () => this.saveExpense());
    onEnter('expense-amount', () => this.saveExpense());

    // Tarih filtreleri + Takvim ileri/geri gezinme
    const activatePeriodBtn = (containerId, period) => {
      document.querySelectorAll(`#${containerId} .date-filter-btn`).forEach(b => {
        b.classList.toggle('active', b.dataset.period === period);
      });
    };

    const bindFilter = (containerId, periodProp, dateProp, render) =>
      on(containerId, 'click', e => {
        const btn = e.target.closest('.date-filter-btn');
        if (!btn) return;
        if (btn.dataset.period === 'today') {
          this[dateProp] = this.todayYMD();
        }
        this[periodProp] = btn.dataset.period;
        activatePeriodBtn(containerId, btn.dataset.period);
        render();
      });
    bindFilter('barber-date-filter', 'currentBarberPeriod', 'currentBarberDate', () => this.renderBarberDashboard());
    bindFilter('admin-date-filter', 'currentAdminPeriod', 'currentAdminDate', () => this.renderAdminDashboard());

    // Berber Takvim İleri/Geri/Seçim
    on('barber-prev-day', 'click', () => {
      this.currentBarberDate = this.shiftDate(this.currentBarberDate, -1);
      this.currentBarberPeriod = 'today';
      activatePeriodBtn('barber-date-filter', 'today');
      this.renderBarberDashboard();
    });
    on('barber-next-day', 'click', () => {
      this.currentBarberDate = this.shiftDate(this.currentBarberDate, 1);
      this.currentBarberPeriod = 'today';
      activatePeriodBtn('barber-date-filter', 'today');
      this.renderBarberDashboard();
    });
    on('barber-calendar-input', 'change', e => {
      if (!e.target.value) return;
      this.currentBarberDate = e.target.value;
      this.currentBarberPeriod = 'today';
      activatePeriodBtn('barber-date-filter', 'today');
      this.renderBarberDashboard();
    });

    // Yönetici Takvim İleri/Geri/Seçim
    on('admin-prev-day', 'click', () => {
      this.currentAdminDate = this.shiftDate(this.currentAdminDate, -1);
      this.currentAdminPeriod = 'today';
      activatePeriodBtn('admin-date-filter', 'today');
      this.renderAdminDashboard();
    });
    on('admin-next-day', 'click', () => {
      this.currentAdminDate = this.shiftDate(this.currentAdminDate, 1);
      this.currentAdminPeriod = 'today';
      activatePeriodBtn('admin-date-filter', 'today');
      this.renderAdminDashboard();
    });
    on('admin-calendar-input', 'change', e => {
      if (!e.target.value) return;
      this.currentAdminDate = e.target.value;
      this.currentAdminPeriod = 'today';
      activatePeriodBtn('admin-date-filter', 'today');
      this.renderAdminDashboard();
    });

    on('barber-history-btn', 'click', () => {
      document.querySelector('#barber-date-filter [data-period="all"]')?.click();
      this.showToast(t('historyAll'));
    });

    // Ayarlar & PDF Rapor İndirme
    on('admin-settings-btn', 'click', () => {
      document.getElementById('settings-new-password').value = '';
      const reportDateInput = document.getElementById('report-date-input');
      if (reportDateInput) reportDateInput.value = this.currentAdminDate || this.todayYMD();
      this.openModal('modal-settings');
    });
    on('btn-pdf-daily', 'click', () => this.downloadPdfReport('today'));
    on('btn-pdf-monthly', 'click', () => this.downloadPdfReport('month'));
    on('btn-pdf-yearly', 'click', () => this.downloadPdfReport('year'));
    on('btn-save-password', 'click', () => this.savePassword());
    onEnter('settings-new-password', () => this.savePassword());
    on('btn-export-data', 'click', () => this.exportData());
    on('btn-close-settings', 'click', () => this.closeModal('modal-settings'));

    // Onay modalı
    on('btn-confirm-yes', 'click', () => {
      const cb = this.confirmCallback;
      this.confirmCallback = null;
      this.closeModal('modal-confirm');
      if (typeof cb === 'function') cb();
    });
    on('btn-confirm-no', 'click', () => {
      this.confirmCallback = null;
      this.closeModal('modal-confirm');
    });

    // Modal dışına tıklayınca kapat
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.remove('active');
      });
    });
  }
};

window.App = App;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
