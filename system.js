const firebaseConfig = {
  apiKey: "AIzaSyA1KjpKO1YV2JKYYiIATkWbTyQX3WLEltQ",
  authDomain: "my-keuangan-cf8b5.firebaseapp.com",
  databaseURL: "https://my-keuangan-cf8b5-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "my-keuangan-cf8b5",
  storageBucket: "my-keuangan-cf8b5.firebasestorage.app",
  messagingSenderId: "1025640079842",
  appId: "1:1025640079842:web:dd7ce1546c85832499d9bb"
};

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
        signInAnonymously: authSdk.signInAnonymously,
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
    'auth/operation-not-allowed': 'Aktifkan metode Anonymous di Firebase Authentication.',
    'auth/network-request-failed': 'Koneksi internet bermasalah.',
    'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi nanti.'
  };
  return messages[error?.code] || error?.message || 'Terjadi kesalahan yang tidak diketahui.';
}

function cacheData(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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
let isUnlocked = false;
let appStarted = false;

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
  setSyncStatus(
    `${prefix}. Perubahan tetap tersimpan lokal. ${firebaseErrorText(error)}`,
    true
  );
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
  try {
    const accountRef = firebaseSdk.ref(firebaseSdk.database, `users/${user.uid}/appData`);
    const result = await firebaseSdk.runTransaction(
      accountRef,
      (remoteData) => remoteData === null || hadPendingSync ? localSnapshot : remoteData,
      { applyLocally: false }
    );

    if (version !== authStateVersion || firebaseSdk.auth.currentUser?.uid !== user.uid) return;
    if (!result.committed) throw new Error('Firebase tidak menerima perubahan data.');

    userDataRef = accountRef;
    if (localRevision !== dataRevision) {
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

async function connectToFirebase() {
  if (!isUnlocked) return;
  if (isConnecting) return;
  isConnecting = true;
  const retryButton = document.getElementById('retrySyncButton');
  retryButton.disabled = true;
  retryButton.hidden = true;
  setSyncStatus('Menghubungkan ke Firebase...');
  try {
    const sdk = await loadFirebaseSdk();
    const observerStartedNow = !authObserverStarted;
    if (observerStartedNow) {
      authObserverStarted = true;
      sdk.onAuthStateChanged(sdk.auth, (user) => {
        const version = ++authStateVersion;
        if (unsubscribeData) {
          unsubscribeData();
          unsubscribeData = null;
        }
        currentUser = user;
        userDataRef = null;
        if (user) {
          loadUserData(user, version);
        } else if (!isConnecting) {
          setSyncStatus('Perubahan tersimpan lokal; menghubungkan kembali...');
          connectToFirebase();
        }
      });
    }

    if (sdk.auth.currentUser) {
      if (!observerStartedNow) {
        currentUser = sdk.auth.currentUser;
        await loadUserData(sdk.auth.currentUser, ++authStateVersion);
      }
    } else {
      await sdk.signInAnonymously(sdk.auth);
    }
  } catch (error) {
    showSyncError(error, 'Firebase belum tersambung');
  } finally {
    isConnecting = false;
    retryButton.disabled = false;
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

// ========== KUNCI APLIKASI (SANDI) ==========
const LOCK_KEY = 'keuanganPribadiLock';
const LOCK_ATTEMPT_KEY = 'keuanganPribadiLockAttempts';
const LOCK_ITERATIONS = 210000;
const LOCK_MIN_LENGTH = 6;
const LOCK_FREE_ATTEMPTS = 4;
const LOCKOUT_STEP_MS = 30 * 1000;
const AUTO_LOCK_MS = 10 * 60 * 1000;

const lockView = document.getElementById('lockView');
const lockSetupPanel = document.getElementById('lockSetup');
const lockUnlockPanel = document.getElementById('lockUnlock');
const lockRecoveryPanel = document.getElementById('lockRecovery');
const lockRecoveryCodePanel = document.getElementById('lockRecoveryCode');
const setupForm = document.getElementById('formSetupSandi');
const unlockForm = document.getElementById('formUnlock');
const recoveryForm = document.getElementById('formRecovery');
const setupMessage = document.getElementById('setupMessage');
const unlockMessage = document.getElementById('unlockMessage');
const recoveryMessage = document.getElementById('recoveryMessage');
const recoveryCodeValue = document.getElementById('recoveryCodeValue');
const recoveryCodeMessage = document.getElementById('recoveryCodeMessage');
const setupTitle = document.getElementById('setupTitle');
const setupDescription = document.getElementById('setupDescription');
const passwordModal = document.getElementById('passwordModal');
const changePasswordForm = document.getElementById('formUbahSandi');
const changePasswordMessage = document.getElementById('ubahSandiMessage');

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let idleTimer = null;
let countdownTimer = null;
let currentRecoveryCode = '';

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function fallbackHash(password, salt, iterations) {
  const bytes = new TextEncoder().encode(password);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  const mix = (value) => {
    h1 = h2 ^ Math.imul(h1 ^ value, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ value, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ value, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ value, 2716044179);
  };
  for (let i = 0; i < salt.length; i += 1) mix(salt[i]);
  for (let i = 0; i < bytes.length; i += 1) mix(bytes[i]);
  const length = Math.max(1, bytes.length);
  for (let i = 0; i < iterations; i += 1) {
    mix(i);
    mix(bytes[i % length] ^ salt[i % salt.length]);
  }
  const part = (value) => (value >>> 0).toString(16).padStart(8, '0');
  return part(h1) + part(h2) + part(h3) + part(h4)
    + part(h1 ^ h3) + part(h2 ^ h4) + part(h1 + h4) + part(h2 + h3);
}

async function pbkdf2Hash(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256
  );
  return toHex(new Uint8Array(bits));
}

async function createPasswordHash(password) {
  const salt = randomSalt();
  let algo = 'pbkdf2-sha256';
  let hash = null;
  if (globalThis.crypto?.subtle) {
    try {
      hash = await pbkdf2Hash(password, salt, LOCK_ITERATIONS);
    } catch (error) {
      console.warn('PBKDF2 tidak tersedia, memakai hash cadangan:', error);
    }
  }
  if (!hash) {
    algo = 'fallback';
    hash = fallbackHash(password, salt, LOCK_ITERATIONS);
  }
  return { algo, salt, hash };
}

async function verifyPassword(password, record) {
  const salt = fromHex(record.salt);
  const iterations = Number(record.iterations) || LOCK_ITERATIONS;
  let hash = null;
  if (record.algo !== 'fallback' && globalThis.crypto?.subtle) {
    try {
      hash = await pbkdf2Hash(password, salt, iterations);
    } catch (error) {
      console.warn('PBKDF2 gagal, memakai hash cadangan:', error);
    }
  }
  if (!hash) hash = fallbackHash(password, salt, iterations);
  return safeEqual(hash, record.hash);
}

async function verifyRecoveryCode(code, record) {
  if (!record.recoveryHash || !record.recoverySalt) return false;
  const salt = fromHex(record.recoverySalt);
  const iterations = Number(record.iterations) || LOCK_ITERATIONS;
  let hash = null;
  if (record.recoveryAlgo !== 'fallback' && globalThis.crypto?.subtle) {
    try {
      hash = await pbkdf2Hash(code, salt, iterations);
    } catch (error) {
      console.warn('PBKDF2 gagal, memakai hash cadangan:', error);
    }
  }
  if (!hash) hash = fallbackHash(code, salt, iterations);
  return safeEqual(hash, record.recoveryHash);
}

function generateRecoveryCode() {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let code = '';
  for (let i = 0; i < bytes.length; i += 1) {
    code += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function randomSalt() {
  const salt = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(salt);
  } else {
    for (let i = 0; i < salt.length; i += 1) salt[i] = Math.floor(Math.random() * 256);
  }
  return salt;
}

function readLockRecord() {
  try {
    const record = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
    if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return null;
    return record;
  } catch (error) {
    console.error('Data kunci aplikasi rusak:', error);
    return null;
  }
}

function writeLockRecord({ algo, salt, hash, recoveryAlgo = null, recoverySalt = null, recoveryHash = null }) {
  const record = {
    v: 1,
    algo,
    iterations: LOCK_ITERATIONS,
    salt: toHex(salt),
    hash,
    updatedAt: Date.now()
  };
  if (recoveryHash && recoverySalt) {
    record.recoveryAlgo = recoveryAlgo;
    record.recoverySalt = toHex(recoverySalt);
    record.recoveryHash = recoveryHash;
  }
  localStorage.setItem(LOCK_KEY, JSON.stringify(record));
  return record;
}

function readAttempts() {
  try {
    const value = JSON.parse(sessionStorage.getItem(LOCK_ATTEMPT_KEY) || 'null');
    if (!value || typeof value !== 'object') return { count: 0, until: 0 };
    return { count: Number(value.count) || 0, until: Number(value.until) || 0 };
  } catch (error) {
    return { count: 0, until: 0 };
  }
}

function writeAttempts(value) {
  try {
    sessionStorage.setItem(LOCK_ATTEMPT_KEY, JSON.stringify(value));
  } catch (error) {
    console.error('Gagal menyimpan percobaan sandi:', error);
  }
}

function clearAttempts() {
  try {
    sessionStorage.removeItem(LOCK_ATTEMPT_KEY);
  } catch (error) {
    console.error('Gagal menghapus percobaan sandi:', error);
  }
}

function refreshUnlockAvailability() {
  const submit = unlockForm.querySelector('button[type="submit"]');
  const input = document.getElementById('sandiMasuk');
  const remaining = Math.ceil((readAttempts().until - Date.now()) / 1000);

  if (remaining > 0) {
    submit.disabled = true;
    input.disabled = true;
    unlockMessage.textContent = `Terlalu banyak percobaan. Coba lagi dalam ${remaining} detik.`;
    if (!countdownTimer) {
      countdownTimer = setInterval(refreshUnlockAvailability, 500);
    }
  } else {
    submit.disabled = false;
    input.disabled = false;
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (unlockMessage.textContent.startsWith('Terlalu banyak percobaan')) {
      unlockMessage.textContent = '';
    }
  }
}

function showLockPanel(name) {
  const panels = {
    setup: lockSetupPanel,
    unlock: lockUnlockPanel,
    recovery: lockRecoveryPanel,
    code: lockRecoveryCodePanel
  };
  Object.entries(panels).forEach(([key, panel]) => {
    panel.hidden = key !== name;
  });
}

function showSetupPanel(mode = 'create') {
  showLockPanel('setup');
  const resetting = mode === 'reset';
  setupTitle.textContent = resetting ? 'Buat sandi baru' : 'Buat sandi aplikasi';
  setupDescription.textContent = resetting
    ? 'Kode pemulihan terverifikasi. Tentukan sandi baru untuk aplikasi ini.'
    : 'Sandi ini diminta setiap kali aplikasi dibuka di perangkat ini. Minimal 6 karakter.';
  setupMessage.textContent = '';
  setupForm.reset();
  document.getElementById('sandiBaru').focus();
}

function showUnlockPanel() {
  showLockPanel('unlock');
  unlockForm.reset();
  unlockMessage.textContent = '';
  refreshUnlockAvailability();
  document.getElementById('sandiMasuk').focus();
}

function showRecoveryPanel() {
  showLockPanel('recovery');
  recoveryForm.reset();
  recoveryMessage.textContent = '';
  document.getElementById('kodePemulihan').focus();
}

function showRecoveryCodePanel(code) {
  currentRecoveryCode = code;
  showLockPanel('code');
  recoveryCodeValue.textContent = code;
  setRecoveryCodeMessage('');
  document.getElementById('copyRecoveryButton').focus();
}

function setRecoveryCodeMessage(text, ok = false) {
  recoveryCodeMessage.textContent = text;
  recoveryCodeMessage.classList.toggle('ok', ok);
}

function unlockApp() {
  isUnlocked = true;
  lockView.hidden = true;
  document.getElementById('app').hidden = false;
  startApp();
  resetIdleTimer();
}

function lockApp() {
  if (!isUnlocked) return;
  isUnlocked = false;
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!passwordModal.hidden) closeChangePassword();
  document.getElementById('app').hidden = true;
  lockView.hidden = false;
  showUnlockPanel();
}

function resetIdleTimer() {
  if (!isUnlocked) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(lockApp, AUTO_LOCK_MS);
}

async function handleSetupSubmit(event) {
  event.preventDefault();
  setupMessage.textContent = '';
  const password = document.getElementById('sandiBaru').value;
  const confirmation = document.getElementById('sandiKonfirmasi').value;

  if (password.length < LOCK_MIN_LENGTH) {
    setupMessage.textContent = `Sandi minimal ${LOCK_MIN_LENGTH} karakter.`;
    return;
  }
  if (password !== confirmation) {
    setupMessage.textContent = 'Konfirmasi sandi tidak sama.';
    return;
  }

  const button = setupForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { algo, salt, hash } = await createPasswordHash(password);
    const recoveryCode = generateRecoveryCode();
    const recovery = await createPasswordHash(normalizeRecoveryCode(recoveryCode));
    writeLockRecord({
      algo,
      salt,
      hash,
      recoveryAlgo: recovery.algo,
      recoverySalt: recovery.salt,
      recoveryHash: recovery.hash
    });
    setupForm.reset();
    clearAttempts();
    showRecoveryCodePanel(recoveryCode);
  } catch (error) {
    console.error('Gagal menyimpan sandi:', error);
    setupMessage.textContent = 'Sandi gagal disimpan. Coba lagi.';
  } finally {
    button.disabled = false;
  }
}

async function handleRecoverySubmit(event) {
  event.preventDefault();
  recoveryMessage.textContent = '';

  const record = readLockRecord();
  if (!record) {
    showSetupPanel();
    return;
  }
  if (!record.recoveryHash) {
    recoveryMessage.textContent = 'Kunci ini tidak punya kode pemulihan. Hapus kunci lewat pengaturan situs di browser untuk mengatur ulang.';
    return;
  }

  const code = normalizeRecoveryCode(document.getElementById('kodePemulihan').value);
  if (code.length < 8) {
    recoveryMessage.textContent = 'Kode pemulihan belum lengkap.';
    return;
  }

  const button = recoveryForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const valid = await verifyRecoveryCode(code, record);
    if (!valid) {
      recoveryMessage.textContent = 'Kode pemulihan salah.';
      return;
    }
    clearAttempts();
    document.getElementById('kodePemulihan').value = '';
    showSetupPanel('reset');
  } catch (error) {
    console.error('Gagal memeriksa kode pemulihan:', error);
    recoveryMessage.textContent = 'Gagal memeriksa kode. Coba lagi.';
  } finally {
    button.disabled = false;
  }
}

async function copyRecoveryCode() {
  if (!currentRecoveryCode) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard tidak tersedia');
    await navigator.clipboard.writeText(currentRecoveryCode);
    setRecoveryCodeMessage('Kode disalin ke clipboard.', true);
  } catch (error) {
    console.warn('Gagal menyalin kode pemulihan:', error);
    setRecoveryCodeMessage('Gagal menyalin otomatis. Klik kodenya lalu salin manual.');
  }
}

function confirmRecoveryCode() {
  currentRecoveryCode = '';
  unlockApp();
}

async function handleUnlockSubmit(event) {
  event.preventDefault();
  if (readAttempts().until > Date.now()) {
    refreshUnlockAvailability();
    return;
  }

  const record = readLockRecord();
  if (!record) {
    showSetupPanel();
    return;
  }

  const input = document.getElementById('sandiMasuk');
  const button = unlockForm.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const valid = await verifyPassword(input.value, record);
    if (valid) {
      clearAttempts();
      unlockMessage.textContent = '';
      input.value = '';
      unlockApp();
      return;
    }

    const attempts = readAttempts();
    attempts.count += 1;
    if (attempts.count > LOCK_FREE_ATTEMPTS) {
      attempts.until = Date.now() + LOCKOUT_STEP_MS * (attempts.count - LOCK_FREE_ATTEMPTS);
    }
    writeAttempts(attempts);
    input.value = '';
    refreshUnlockAvailability();
    if (attempts.until <= Date.now()) {
      const remaining = Math.max(1, LOCK_FREE_ATTEMPTS - attempts.count + 1);
      unlockMessage.textContent = `Sandi salah. Sisa percobaan sebelum jeda: ${remaining}.`;
    }
  } catch (error) {
    console.error('Gagal memeriksa sandi:', error);
    unlockMessage.textContent = 'Gagal memeriksa sandi. Coba lagi.';
  } finally {
    if (readAttempts().until <= Date.now()) button.disabled = false;
  }
}

function openChangePassword() {
  changePasswordForm.reset();
  changePasswordMessage.textContent = '';
  passwordModal.hidden = false;
  document.getElementById('sandiLama').focus();
}

function closeChangePassword() {
  passwordModal.hidden = true;
  changePasswordForm.reset();
  changePasswordMessage.textContent = '';
}

async function handleChangePassword(event) {
  event.preventDefault();
  changePasswordMessage.textContent = '';

  const current = document.getElementById('sandiLama').value;
  const next = document.getElementById('sandiBaruUbah').value;
  const confirmation = document.getElementById('sandiKonfirmasiUbah').value;

  if (next.length < LOCK_MIN_LENGTH) {
    changePasswordMessage.textContent = `Sandi minimal ${LOCK_MIN_LENGTH} karakter.`;
    return;
  }
  if (next !== confirmation) {
    changePasswordMessage.textContent = 'Konfirmasi sandi baru tidak sama.';
    return;
  }

  const record = readLockRecord();
  if (!record) {
    changePasswordMessage.textContent = 'Sandi aplikasi belum diatur.';
    return;
  }

  const button = changePasswordForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const valid = await verifyPassword(current, record);
    if (!valid) {
      changePasswordMessage.textContent = 'Sandi saat ini salah.';
      return;
    }
    const { algo, salt, hash } = await createPasswordHash(next);
    writeLockRecord({
      algo,
      salt,
      hash,
      recoveryAlgo: record.recoveryAlgo,
      recoverySalt: record.recoverySalt ? fromHex(record.recoverySalt) : null,
      recoveryHash: record.recoveryHash
    });
    clearAttempts();
    closeChangePassword();
    alert('Sandi berhasil diubah.');
  } catch (error) {
    console.error('Gagal mengubah sandi:', error);
    changePasswordMessage.textContent = 'Sandi gagal diubah. Coba lagi.';
  } finally {
    button.disabled = false;
  }
}

function initLock() {
  setupForm.addEventListener('submit', handleSetupSubmit);
  unlockForm.addEventListener('submit', handleUnlockSubmit);
  recoveryForm.addEventListener('submit', handleRecoverySubmit);
  changePasswordForm.addEventListener('submit', handleChangePassword);

  document.getElementById('showRecoveryButton').addEventListener('click', showRecoveryPanel);
  document.getElementById('kembaliKeUnlock').addEventListener('click', showUnlockPanel);
  document.getElementById('copyRecoveryButton').addEventListener('click', copyRecoveryCode);
  document.getElementById('confirmRecoveryButton').addEventListener('click', confirmRecoveryCode);

  document.getElementById('lockButton').addEventListener('click', lockApp);
  document.getElementById('changePasswordButton').addEventListener('click', openChangePassword);
  document.getElementById('batalUbahSandi').addEventListener('click', closeChangePassword);
  passwordModal.addEventListener('click', (event) => {
    if (event.target === passwordModal) closeChangePassword();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !passwordModal.hidden) closeChangePassword();
  });
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, resetIdleTimer, { passive: true });
  });

  document.getElementById('app').hidden = true;
  lockView.hidden = false;
  if (readLockRecord()) {
    showUnlockPanel();
  } else {
    showSetupPanel();
  }
}

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

function startApp() {
  document.getElementById('app').hidden = false;
  lockView.hidden = true;
  renderAll();
  if (appStarted) return;
  appStarted = true;
  setSyncStatus(
    pendingSync
      ? 'Perubahan tersimpan lokal; menunggu sinkronisasi.'
      : 'Data lokal siap; menghubungkan ke Firebase...'
  );
  connectToFirebase();
}

initLock();
