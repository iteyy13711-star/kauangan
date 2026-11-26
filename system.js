const firebaseConfig = {
  apiKey: "AIzaSyA1KjpKO1YV2JKYYiIATkWbTyQX3WLEltQ",
  authDomain: "my-keuangan-cf8b5.firebaseapp.com",
  databaseURL: "https://my-keuangan-cf8b5-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "my-keuangan-cf8b5",
  storageBucket: "my-keuangan-cf8b5.firebasestorage.app",
  messagingSenderId: "1025640079842",
  appId: "1:1025640079842:web:dd7ce1546c85832499d9bb"
};
const SHARED_AUTH_EMAIL = `keuanganku-shared@${firebaseConfig.projectId}.firebaseapp.com`;

let firebaseSdk = null;
let firebaseSdkPromise = null;
let authObserverStarted = false;
let isConnecting = false;

function loadFirebaseSdk() {
  if (firebaseSdk) return Promise.resolve(firebaseSdk);
  if (!firebaseSdkPromise) {
    firebaseSdkPromise = Promise.all([
      import("https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js")
    ]).then(([appSdk, authSdk, databaseSdk]) => {
      const app = appSdk.initializeApp(firebaseConfig);
      const auth = authSdk.getAuth(app);
      const database = databaseSdk.getDatabase(app);
      firebaseSdk = {
        auth,
        database,
        onAuthStateChanged: authSdk.onAuthStateChanged,
        signInWithEmailAndPassword: authSdk.signInWithEmailAndPassword,
        signOut: authSdk.signOut,
        onValue: databaseSdk.onValue,
        ref: databaseSdk.ref,
        runTransaction: databaseSdk.runTransaction,
        set: databaseSdk.set
      };
      return firebaseSdk;
    }).catch((error) => {
      firebaseSdkPromise = null;
      throw error;
    });
  }
  return firebaseSdkPromise;
}

// ========== DATA STORAGE ==========
const STORAGE_KEY = 'keuanganPribadiData';
const PENDING_SYNC_KEY = `${STORAGE_KEY}:pendingSync`;
const CACHE_OWNER_KEY = `${STORAGE_KEY}:owner`;
const CACHE_OWNER_ANONYMOUS_KEY = `${STORAGE_KEY}:ownerAnonymous`;

function emptyData() {
  return {
    transaksi: [],
    wishlist: [],
    catatan: [],
    target: null
  };
}

function normalizeData(value) {
  const asArray = (items) => {
    if (Array.isArray(items)) return items.filter(Boolean);
    if (items && typeof items === 'object') return Object.values(items).filter(Boolean);
    return [];
  };

  return {
    transaksi: asArray(value?.transaksi),
    wishlist: asArray(value?.wishlist),
    catatan: asArray(value?.catatan),
    target: value?.target && typeof value.target === 'object' ? value.target : null
  };
}

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyData();
  try {
    return normalizeData(JSON.parse(raw));
  } catch (error) {
    console.error('Data lokal rusak, memakai data kosong:', error);
    return emptyData();
  }
}

function toDatabaseData(value) {
  const toMap = (items) => Object.fromEntries(items.map((item) => [item.id, item]));
  return {
    schemaVersion: 1,
    transaksi: toMap(value.transaksi),
    wishlist: toMap(value.wishlist),
    catatan: toMap(value.catatan),
    target: value.target
  };
}

function mergeDatabaseData(remoteData, localData) {
  const mergeMap = (remote, local) => ({ ...(local || {}), ...(remote || {}) });
  return {
    schemaVersion: 1,
    transaksi: mergeMap(remoteData?.transaksi, localData.transaksi),
    wishlist: mergeMap(remoteData?.wishlist, localData.wishlist),
    catatan: mergeMap(remoteData?.catatan, localData.catatan),
    target: remoteData?.target ?? localData.target ?? null
  };
}

function firebaseErrorText(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (
    code.includes('permission-denied') ||
    code.includes('permission_denied') ||
    message.includes('permission denied') ||
    message.includes('permission_denied')
  ) {
    return 'Akses Realtime Database ditolak. Pastikan aturan database sudah diterbitkan.';
  }

  const messages = {
    'auth/invalid-credential': 'Sandi salah atau akun bersama belum disiapkan di Firebase.',
    'auth/user-not-found': 'Akun bersama belum disiapkan di Firebase.',
    'auth/wrong-password': 'Sandi akun bersama salah.',
    'auth/user-disabled': 'Akun ini dinonaktifkan. Hubungi administrator.',
    'auth/operation-not-allowed': 'Aktifkan metode Email/Password di Firebase Authentication.',
    'auth/network-request-failed': 'Koneksi internet bermasalah.',
    'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi nanti.'
  };
  return messages[error?.code] || error?.message || 'Terjadi kesalahan yang tidak diketahui.';
}

function cacheData(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    if (currentUser) {
      localStorage.setItem(CACHE_OWNER_KEY, currentUser.uid);
      localStorage.setItem(CACHE_OWNER_ANONYMOUS_KEY, String(currentUser.isAnonymous));
    }
  } catch (error) {
    console.error('Gagal menyimpan cache lokal:', error);
    alert('Data tetap tersimpan di Firebase, tetapi cache browser gagal diperbarui.');
  }
}

let currentUser = null;
let userDataRef = null;
let unsubscribeData = null;
let authStateVersion = 0;
let dataRevision = 0;
let pendingSync = localStorage.getItem(PENDING_SYNC_KEY) === 'true';
let writeQueue = Promise.resolve();

function setSyncStatus(message, retry = false) {
  document.getElementById('syncStatus').textContent = message;
  document.getElementById('retrySyncButton').hidden = !retry;
}

function setPendingSync(value) {
  pendingSync = value;
  try {
    localStorage.setItem(PENDING_SYNC_KEY, String(value));
  } catch (error) {
    console.error('Gagal menyimpan status sinkronisasi lokal:', error);
  }
}

let data = loadData();

function saveData() {
  dataRevision += 1;
  setPendingSync(true);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (userDataRef && currentUser) {
      localStorage.setItem(CACHE_OWNER_KEY, currentUser.uid);
      localStorage.setItem(CACHE_OWNER_ANONYMOUS_KEY, String(currentUser.isAnonymous));
    }
    setSyncStatus('Perubahan tersimpan di perangkat; menunggu sinkronisasi.');
  } catch (error) {
    console.error('Gagal menyimpan cache lokal:', error);
    setSyncStatus('Cache lokal gagal disimpan; mencoba Firebase.');
    alert('Data gagal disimpan di browser. Periksa ruang penyimpanan yang tersedia.');
  }
  syncPendingData();
}

function syncPendingData() {
  if (!pendingSync || !userDataRef || !currentUser || !firebaseSdk) return;

  const accountRef = userDataRef;
  const user = currentUser;
  const revision = dataRevision;
  const snapshot = toDatabaseData(data);
  setSyncStatus('Menyinkronkan perubahan ke Firebase...');
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    if (firebaseSdk.auth.currentUser?.uid !== user.uid || userDataRef !== accountRef) return;
    await firebaseSdk.set(accountRef, snapshot);
    if (firebaseSdk.auth.currentUser?.uid !== user.uid || userDataRef !== accountRef) return;
    if (revision === dataRevision) {
      setPendingSync(false);
      setSyncStatus('Tersinkron dengan Firebase.');
    }
  }).catch((error) => {
    console.error('Gagal menyimpan data Firebase:', error);
    setSyncStatus(`Perubahan tetap tersimpan lokal; Firebase belum tersinkron. ${firebaseErrorText(error)}`, true);
  });
}

function updateDataFromFirebase(snapshot) {
  if (pendingSync) return;
  data = normalizeData(snapshot.val());
  cacheData(data);
  renderAll();
  setSyncStatus('Tersinkron dengan Firebase.');
}

function showSyncError(error, prefix) {
  console.error(`${prefix}:`, error);
  const message = `${prefix}. Perubahan tetap tersimpan lokal. ${firebaseErrorText(error)}`;
  if (document.getElementById('app').hidden) {
    document.getElementById('authMessage').textContent = message;
    document.getElementById('retryAuthButton').hidden = false;
  } else {
    setSyncStatus(message, true);
  }
}

function startRealtimeSync(accountRef, user) {
  if (unsubscribeData) unsubscribeData();
  unsubscribeData = firebaseSdk.onValue(accountRef, (snapshot) => {
    if (firebaseSdk.auth.currentUser?.uid !== user.uid) return;
    updateDataFromFirebase(snapshot);
  }, (error) => {
    showSyncError(error, 'Gagal menerima sinkronisasi data');
  });
}

async function loadUserData(user, version) {
  setSyncStatus('Mengambil data dari Firebase...');
  const localRevision = dataRevision;
  const hadPendingSync = pendingSync;
  const localSnapshot = toDatabaseData(data);
  const cachedOwner = localStorage.getItem(CACHE_OWNER_KEY);
  const cachedOwnerIsAnonymous = localStorage.getItem(CACHE_OWNER_ANONYMOUS_KEY) === 'true';
  const hasLocalData = data.transaksi.length > 0 ||
    data.wishlist.length > 0 ||
    data.catatan.length > 0 ||
    data.target !== null;
  const canImportLocalData = !cachedOwner || cachedOwner === user.uid || cachedOwnerIsAnonymous;
  const importLocalData = cachedOwner !== user.uid && hasLocalData && canImportLocalData;
  const replaceRemoteWithLocal = hadPendingSync &&
    (!cachedOwner || cachedOwner === user.uid) &&
    !importLocalData;
  const initialData = canImportLocalData ? localSnapshot : toDatabaseData(emptyData());
  try {
    const accountRef = firebaseSdk.ref(firebaseSdk.database, `users/${user.uid}/appData`);
    const result = await firebaseSdk.runTransaction(
      accountRef,
      (remoteData) => {
        if (remoteData === null) return initialData;
        if (importLocalData) return mergeDatabaseData(remoteData, localSnapshot);
        return replaceRemoteWithLocal ? localSnapshot : remoteData;
      },
      { applyLocally: false }
    );

    if (version !== authStateVersion || firebaseSdk.auth.currentUser?.uid !== user.uid) return;
    if (!result.committed) throw new Error('Firebase tidak menerima perubahan data.');

    userDataRef = accountRef;
    if (localRevision !== dataRevision) {
      if (importLocalData) {
        data = normalizeData(mergeDatabaseData(result.snapshot.val(), toDatabaseData(data)));
        cacheData(data);
      }
      startRealtimeSync(accountRef, user);
      syncPendingData();
      return;
    }
    data = normalizeData(result.snapshot.val());
    cacheData(data);
    if (hadPendingSync) setPendingSync(false);
    setSyncStatus('Tersinkron dengan Firebase.');
    startRealtimeSync(accountRef, user);
  } catch (error) {
    if (version !== authStateVersion) return;
    showSyncError(error, 'Gagal memuat data Firebase');
  }
}

function registerFirebaseAuthObserver(sdk) {
  if (authObserverStarted) return;
  authObserverStarted = true;
  sdk.onAuthStateChanged(sdk.auth, (user) => {
    const version = ++authStateVersion;
    if (unsubscribeData) {
      unsubscribeData();
      unsubscribeData = null;
    }
    currentUser = user;
    userDataRef = null;

    if (!user || user.isAnonymous) {
      document.getElementById('app').hidden = true;
      document.getElementById('authView').hidden = false;
      if (user?.isAnonymous) {
        document.getElementById('authMessage').textContent =
          'Sesi anonim lama tidak dapat menyinkronkan data antarperangkat. Silakan masuk dengan akun.';
      }
      return;
    }

    document.getElementById('authMessage').textContent = '';
    document.getElementById('authForm').reset();
    document.getElementById('authView').hidden = true;
    document.getElementById('app').hidden = false;
    renderAll();
    loadUserData(user, version);
  });
}

async function connectToFirebase() {
  if (isConnecting) return;
  isConnecting = true;
  const retryButton = document.getElementById('retrySyncButton');
  if (!document.getElementById('app').hidden) {
    retryButton.disabled = true;
    retryButton.hidden = true;
    setSyncStatus('Menghubungkan ke Firebase...');
  } else {
    document.getElementById('retryAuthButton').hidden = true;
    document.getElementById('authMessage').textContent = 'Menghubungkan ke Firebase...';
  }
  try {
    const sdk = await loadFirebaseSdk();
    const observerStartedNow = !authObserverStarted;
    registerFirebaseAuthObserver(sdk);
    if (sdk.auth.currentUser && !sdk.auth.currentUser.isAnonymous && !observerStartedNow) {
      currentUser = sdk.auth.currentUser;
      await loadUserData(sdk.auth.currentUser, ++authStateVersion);
    } else if (!sdk.auth.currentUser) {
      document.getElementById('authView').hidden = false;
      document.getElementById('authMessage').textContent =
        'Masuk dengan akun Firebase untuk menyinkronkan data antarperangkat.';
    }
  } catch (error) {
    showSyncError(error, 'Firebase belum tersambung');
  } finally {
    isConnecting = false;
    if (retryButton) retryButton.disabled = false;
  }
}

// ========== UTILITIES ==========
function formatRupiah(angka) {
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function formatTanggal(iso) {
  const d = new Date(iso);
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function setDefaultDatetime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  const val = now.toISOString().slice(0, 16);
  const elMasuk = document.getElementById('tanggalMasuk');
  const elKeluar = document.getElementById('tanggalKeluar');
  if (elMasuk) elMasuk.value = val;
  if (elKeluar) elKeluar.value = val;
}

// ========== NAVIGATION ==========
const pages = document.querySelectorAll('.page');
const navItems = document.querySelectorAll('.nav-item');
const pageTitle = document.getElementById('pageTitle');
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');

const titles = {
  dashboard: 'Dashboard',
  pemasukan: 'Uang Masuk',
  pengeluaran: 'Uang Keluar',
  laporan: 'Laporan Transaksi',
  wishlist: 'Wishlist',
  catatan: 'Catatan',
  target: 'Target Tabungan'
};

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const page = item.dataset.page;

    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    pages.forEach(p => p.classList.remove('active'));
    document.getElementById(page).classList.add('active');

    pageTitle.textContent = titles[page] || page;

    if (page === 'dashboard') renderDashboard();
    if (page === 'laporan') renderLaporan();
    if (page === 'wishlist') renderWishlist();
    if (page === 'catatan') renderCatatan();
    if (page === 'target') renderTarget();

    sidebar.classList.remove('open');
  });
});

menuToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

// ========== DASHBOARD ==========
function renderDashboard() {
  const masuk = data.transaksi.filter(t => t.jenis === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const keluar = data.transaksi.filter(t => t.jenis === 'keluar').reduce((s, t) => s + t.jumlah, 0);
  const saldo = masuk - keluar;

  document.getElementById('totalMasuk').textContent = formatRupiah(masuk);
  document.getElementById('totalKeluar').textContent = formatRupiah(keluar);
  document.getElementById('saldo').textContent = formatRupiah(saldo);

  if (data.target && data.target.jumlah > 0) {
    const pct = Math.min(100, Math.round((data.target.saatIni / data.target.jumlah) * 100));
    document.getElementById('progressTarget').textContent = pct + '%';
  } else {
    document.getElementById('progressTarget').textContent = '0%';
  }

  const list = document.getElementById('recentTransactions');
  const recent = [...data.transaksi].sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal)).slice(0, 8);

  if (recent.length === 0) {
    list.innerHTML = '<p class="empty">Belum ada transaksi</p>';
    return;
  }

  list.innerHTML = recent.map(t => `
    <div class="tx-item">
      <div class="tx-left">
        <div class="tx-icon ${t.jenis === 'masuk' ? 'in' : 'out'}">
          <i class="fas fa-arrow-${t.jenis === 'masuk' ? 'down' : 'up'}"></i>
        </div>
        <div class="tx-info">
          <strong>${escapeHtml(t.keterangan)}</strong>
          <small>${formatTanggal(t.tanggal)}${t.kategori ? ' • ' + escapeHtml(t.kategori) : ''}</small>
        </div>
      </div>
      <div class="tx-amount ${t.jenis === 'masuk' ? 'in' : 'out'}">
        ${t.jenis === 'masuk' ? '+' : '-'} ${formatRupiah(t.jumlah)}
      </div>
    </div>
  `).join('');
}

// ========== PEMASUKAN ==========
document.getElementById('formPemasukan').addEventListener('submit', (e) => {
  e.preventDefault();
  const jumlah = Number(document.getElementById('jumlahMasuk').value);
  const keterangan = document.getElementById('ketMasuk').value.trim();
  const tanggal = document.getElementById('tanggalMasuk').value;

  const transaksi = {
    id: generateId(),
    jenis: 'masuk',
    jumlah,
    keterangan,
    kategori: null,
    tanggal
  };

  data.transaksi = [...data.transaksi.filter((item) => item.id !== transaksi.id), transaksi];
  saveData();
  renderDashboard();
  e.target.reset();
  setDefaultDatetime();
  alert('Pemasukan berhasil disimpan!');
  document.querySelector('[data-page="dashboard"]').click();
});

// ========== PENGELUARAN ==========
document.getElementById('formPengeluaran').addEventListener('submit', (e) => {
  e.preventDefault();
  const jumlah = Number(document.getElementById('jumlahKeluar').value);
  const keterangan = document.getElementById('ketKeluar').value.trim();
  const kategori = document.getElementById('kategoriKeluar').value;
  const tanggal = document.getElementById('tanggalKeluar').value;

  const transaksi = {
    id: generateId(),
    jenis: 'keluar',
    jumlah,
    keterangan,
    kategori,
    tanggal
  };

  data.transaksi = [...data.transaksi.filter((item) => item.id !== transaksi.id), transaksi];
  saveData();
  renderDashboard();
  e.target.reset();
  setDefaultDatetime();
  alert('Pengeluaran berhasil disimpan!');
  document.querySelector('[data-page="dashboard"]').click();
});

// ========== LAPORAN ==========
function renderLaporan(dari = null, sampai = null) {
  let list = [...data.transaksi];

  if (dari) {
    list = list.filter(t => t.tanggal.slice(0, 10) >= dari);
  }
  if (sampai) {
    list = list.filter(t => t.tanggal.slice(0, 10) <= sampai);
  }

  list.sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));

  const masuk = list.filter(t => t.jenis === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const keluar = list.filter(t => t.jenis === 'keluar').reduce((s, t) => s + t.jumlah, 0);

  document.getElementById('laporanMasuk').textContent = formatRupiah(masuk);
  document.getElementById('laporanKeluar').textContent = formatRupiah(keluar);
  document.getElementById('laporanSaldo').textContent = formatRupiah(masuk - keluar);

  const tbody = document.getElementById('tabelLaporanBody');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Tidak ada transaksi pada periode ini</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(t => `
    <tr>
      <td>${formatTanggal(t.tanggal)}</td>
      <td><span class="badge ${t.jenis === 'masuk' ? 'badge-in' : 'badge-out'}">${t.jenis === 'masuk' ? 'Masuk' : 'Keluar'}</span></td>
      <td>${escapeHtml(t.keterangan)}</td>
      <td>${escapeHtml(t.kategori || '-')}</td>
      <td style="font-weight:600; color:${t.jenis === 'masuk' ? 'var(--green)' : 'var(--red)'}">
        ${t.jenis === 'masuk' ? '+' : '-'} ${formatRupiah(t.jumlah)}
      </td>
      <td>
        <button class="btn btn-sm btn-danger" data-delete-transaction="${escapeHtml(t.id)}" aria-label="Hapus transaksi">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('btnFilter').addEventListener('click', () => {
  const dari = document.getElementById('filterDari').value;
  const sampai = document.getElementById('filterSampai').value;
  renderLaporan(dari || null, sampai || null);
});

document.getElementById('btnResetFilter').addEventListener('click', () => {
  document.getElementById('filterDari').value = '';
  document.getElementById('filterSampai').value = '';
  renderLaporan();
});

document.getElementById('tabelLaporanBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-transaction]');
  if (button) hapusTransaksi(button.dataset.deleteTransaction);
});

function hapusTransaksi(id) {
  if (!confirm('Yakin ingin menghapus transaksi ini?')) return;
  data.transaksi = data.transaksi.filter(t => t.id !== id);
  saveData();
  renderLaporan(
    document.getElementById('filterDari').value || null,
    document.getElementById('filterSampai').value || null
  );
  renderDashboard();
}

// ========== WISHLIST ==========
document.getElementById('formWishlist').addEventListener('submit', (e) => {
  e.preventDefault();
  const nama = document.getElementById('wishNama').value.trim();
  const harga = Number(document.getElementById('wishHarga').value);
  const prioritas = document.getElementById('wishPrioritas').value;

  const wishlist = {
    id: generateId(),
    nama,
    harga,
    prioritas,
    selesai: false,
    tanggal: new Date().toISOString()
  };

  data.wishlist = [...data.wishlist.filter((item) => item.id !== wishlist.id), wishlist];
  saveData();
  e.target.reset();
  renderWishlist();
});

function renderWishlist() {
  const container = document.getElementById('wishlistList');
  if (data.wishlist.length === 0) {
    container.innerHTML = '<p class="empty">Belum ada wishlist</p>';
    return;
  }

  const sorted = [...data.wishlist].sort((a, b) => {
    if (a.selesai !== b.selesai) return a.selesai ? 1 : -1;
    const order = { Tinggi: 0, Sedang: 1, Rendah: 2 };
    return order[a.prioritas] - order[b.prioritas];
  });

  container.innerHTML = sorted.map(w => `
    <div class="wish-card ${w.selesai ? 'done' : ''}">
      <h4>${w.selesai ? '✅ ' : ''}${escapeHtml(w.nama)}</h4>
      <div class="harga">${formatRupiah(w.harga)}</div>
      <div class="meta">
        <span class="prioritas ${escapeHtml(w.prioritas.toLowerCase())}">${escapeHtml(w.prioritas)}</span>
        <small>${formatTanggal(w.tanggal).split(',')[0]}</small>
      </div>
      <div class="wish-actions">
        ${!w.selesai ? `
          <button class="btn btn-sm btn-green" data-wishlist-action="complete" data-id="${escapeHtml(w.id)}">
            <i class="fas fa-check"></i> Sudah beli
          </button>
        ` : ''}
        <button class="btn btn-sm btn-danger" data-wishlist-action="delete" data-id="${escapeHtml(w.id)}" aria-label="Hapus wishlist">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `).join('');
}

document.getElementById('wishlistList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-wishlist-action]');
  if (!button) return;
  if (button.dataset.wishlistAction === 'complete') selesaiWishlist(button.dataset.id);
  if (button.dataset.wishlistAction === 'delete') hapusWishlist(button.dataset.id);
});

function selesaiWishlist(id) {
  const item = data.wishlist.find(w => w.id === id);
  if (!item) return;
  item.selesai = true;
  saveData();
  renderWishlist();
}

function hapusWishlist(id) {
  if (!confirm('Hapus item wishlist ini?')) return;
  data.wishlist = data.wishlist.filter(w => w.id !== id);
  saveData();
  renderWishlist();
}

// ========== CATATAN ==========
document.getElementById('formCatatan').addEventListener('submit', (e) => {
  e.preventDefault();
  const judul = document.getElementById('catatanJudul').value.trim();
  const isi = document.getElementById('catatanIsi').value.trim();

  const catatan = {
    id: generateId(),
    judul,
    isi,
    tanggal: new Date().toISOString()
  };

  data.catatan = [catatan, ...data.catatan.filter((item) => item.id !== catatan.id)];
  saveData();
  e.target.reset();
  renderCatatan();
});

function renderCatatan() {
  const container = document.getElementById('catatanList');
  if (data.catatan.length === 0) {
    container.innerHTML = '<p class="empty">Belum ada catatan</p>';
    return;
  }

  container.innerHTML = data.catatan.map(c => `
    <div class="note-card">
      <h4>${escapeHtml(c.judul)}</h4>
      <p>${escapeHtml(c.isi)}</p>
      <div class="note-meta">
        <span>${formatTanggal(c.tanggal)}</span>
        <button class="btn btn-sm btn-danger" data-delete-note="${escapeHtml(c.id)}">
          <i class="fas fa-trash"></i> Hapus
        </button>
      </div>
    </div>
  `).join('');
}

document.getElementById('catatanList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-note]');
  if (button) hapusCatatan(button.dataset.deleteNote);
});

function hapusCatatan(id) {
  if (!confirm('Hapus catatan ini?')) return;
  data.catatan = data.catatan.filter(c => c.id !== id);
  saveData();
  renderCatatan();
}

// ========== TARGET TABUNGAN ==========
document.getElementById('formTarget').addEventListener('submit', (e) => {
  e.preventDefault();
  const nama = document.getElementById('targetNama').value.trim();
  const jumlah = Number(document.getElementById('targetJumlah').value);
  const saatIni = Number(document.getElementById('targetSaatIni').value);

  const target = { nama, jumlah, saatIni };
  data.target = target;
  saveData();
  renderTarget();
  renderDashboard();
  alert('Target tabungan berhasil disimpan!');
});

document.getElementById('formTambahTarget').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!data.target) {
    alert('Buat target terlebih dahulu!');
    return;
  }
  const jumlah = Number(document.getElementById('tambahTargetJumlah').value);
  data.target.saatIni = (Number(data.target.saatIni) || 0) + jumlah;
  saveData();
  e.target.reset();
  renderTarget();
  renderDashboard();
});

function renderTarget() {
  const container = document.getElementById('targetInfo');
  const formNama = document.getElementById('targetNama');
  const formJumlah = document.getElementById('targetJumlah');
  const formSaatIni = document.getElementById('targetSaatIni');

  if (!data.target) {
    container.innerHTML = '<p class="empty">Belum ada target tabungan. Silakan buat di atas.</p>';
    return;
  }

  formNama.value = data.target.nama;
  formJumlah.value = data.target.jumlah;
  formSaatIni.value = data.target.saatIni;

  const pct = Math.min(100, Math.round((data.target.saatIni / data.target.jumlah) * 100));
  const sisa = Math.max(0, data.target.jumlah - data.target.saatIni);

  container.innerHTML = `
    <div class="target-name">${escapeHtml(data.target.nama)}</div>
    <div class="target-amounts">
      <strong>${formatRupiah(data.target.saatIni)}</strong> / ${formatRupiah(data.target.jumlah)}
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${pct}%">${pct > 10 ? pct + '%' : ''}</div>
    </div>
    <div class="progress-text">${pct}%</div>
    <p style="margin-top:12px; color:var(--muted)">
      ${pct >= 100 
        ? '🎉 Selamat! Target sudah tercapai!' 
        : `Sisa yang perlu ditabung: <strong>${formatRupiah(sisa)}</strong>`}
    </p>
  `;
}

// ========== FIREBASE ACCOUNT LOGIN ==========
const authView = document.getElementById('authView');
const authForm = document.getElementById('authForm');
const authPassword = document.getElementById('authPassword');
const authSubmit = document.getElementById('authSubmit');
const authMessage = document.getElementById('authMessage');
const retryAuthButton = document.getElementById('retryAuthButton');

async function handleAuthSubmit(event) {
  event.preventDefault();
  authSubmit.disabled = true;
  authMessage.textContent = '';
  retryAuthButton.hidden = true;

  const password = authPassword.value;
  if (password.length < 6) {
    authMessage.textContent = 'Sandi harus terdiri dari minimal 6 karakter.';
    authSubmit.disabled = false;
    return;
  }

  try {
    const sdk = await loadFirebaseSdk();
    registerFirebaseAuthObserver(sdk);
    await sdk.signInWithEmailAndPassword(sdk.auth, SHARED_AUTH_EMAIL, password);
  } catch (error) {
    console.error('Autentikasi Firebase gagal:', error);
    authMessage.textContent = firebaseErrorText(error);
    if (!firebaseSdk) retryAuthButton.hidden = false;
  } finally {
    authSubmit.disabled = false;
  }
}

authForm.addEventListener('submit', handleAuthSubmit);
retryAuthButton.addEventListener('click', connectToFirebase);

// ========== INIT ==========
document.getElementById('currentDate').textContent = new Date().toLocaleDateString('id-ID', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

setDefaultDatetime();

function renderAll() {
  renderDashboard();
  renderLaporan();
  renderWishlist();
  renderCatatan();
  renderTarget();
}

// ========== LOCAL-FIRST STARTUP ==========
document.getElementById('retrySyncButton').addEventListener('click', connectToFirebase);
window.addEventListener('online', connectToFirebase);
document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    const sdk = await loadFirebaseSdk();
    await sdk.signOut(sdk.auth);
  } catch (error) {
    console.error('Gagal keluar dari akun Firebase:', error);
    setSyncStatus(`Gagal keluar. ${firebaseErrorText(error)}`, true);
  }
});

document.getElementById('app').hidden = true;
authView.hidden = false;
connectToFirebase();
