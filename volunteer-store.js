/*
 * DIRA volunteer registration: shared front-end data layer.
 *
 * Used by volunteer.html (the public form) and volunteer-admin.html (the admin page).
 *
 * STORAGE MODES
 *  - Browser mode (default): the form definition lives in localStorage; registrations and CV files
 *    live in IndexedDB. Data stays in the browser of whoever is using the page.
 *  - API mode: set window.DIRA_VOLUNTEER_API = '/api' before this script loads. The pages then use the
 *    server API and shared MongoDB storage instead of browser-local storage.
 */
(function (global) {
  'use strict';

  var FORM_KEY = 'dira.volunteer.form.v1';
  var API = String(global.DIRA_VOLUNTEER_API || '').replace(/\/+$/, '');
  var MODE = API ? 'api' : 'local';

  var TYPES = {
    short_text: 'Short answer',
    long_text: 'Paragraph',
    email: 'Email address',
    phone: 'Phone number',
    date: 'Date',
    single_choice: 'Multiple choice (one answer)',
    multi_choice: 'Checkboxes (several answers)',
    dropdown: 'Dropdown',
    file: 'File upload'
  };
  var CHOICE_TYPES = ['single_choice', 'multi_choice', 'dropdown'];
  var TEXT_TYPES = ['short_text', 'long_text', 'email', 'phone'];

  /* ------------------------------------------------------------ default form */
  var DEFAULT_FORM = {
    version: 1,
    title: 'DIRA Volunteer Application',
    subtitle: 'DIRA Volunteer Application Form',
    intro: [
      'Thank you for your interest in volunteering with DIRA. This form will help us assign you the most suitable role in our programmes.',
      'By submitting this form, you consent to DIRA storing and processing your personal information for volunteer coordination purposes only. Your data will not be shared with third parties without your permission.',
      'For questions, contact us at [diradigitalera@gmail.com](mailto:diradigitalera@gmail.com).\nWhatsApp: [+237 682 36 64 72](https://wa.me/237682366472)'
    ].join('\n\n'),
    submitLabel: 'Submit application',
    notifyEmail: 'diradigitalera@gmail.com',
    sections: [
      { id: 's1', title: 'Personal Information', description: '' },
      { id: 's2', title: 'Skills & Roles', description: '' },
      { id: 's3', title: 'Availability & Commitment', description: '' },
      { id: 's4', title: 'Background & Motivation', description: '' },
      { id: 's5', title: 'Reliability Check', description: '' }
    ],
    questions: [
      { id: 'fullName', sectionId: 's1', type: 'short_text', label: 'Full Name', required: true, use: 'name', maxLength: 120 },
      { id: 'email', sectionId: 's1', type: 'email', label: 'Email Address', required: true, use: 'email', maxLength: 160 },
      { id: 'phone', sectionId: 's1', type: 'phone', label: 'Phone Number (WhatsApp preferred)', required: false, use: 'phone', maxLength: 30 },
      { id: 'location', sectionId: 's1', type: 'short_text', label: 'Location (City, Country)', required: true, maxLength: 120 },
      { id: 'education', sectionId: 's1', type: 'short_text', label: 'Level of Education (e.g. 1st year university student, secondary school student, graduate, etc.)', required: true, maxLength: 160 },
      { id: 'dob', sectionId: 's1', type: 'date', label: 'Date of Birth', required: true, dateRule: 'past' },
      { id: 'gender', sectionId: 's1', type: 'single_choice', label: 'Gender', required: true, options: ['Male', 'Female'] },

      { id: 'areas', sectionId: 's2', type: 'multi_choice', label: 'Which of the following areas can you contribute in? (Select all that apply)', required: true,
        options: ['Field Workers', 'Communications Officer', 'Psychologist', 'GBV Counsellor', 'Fiscal Experts / Business Consultants', 'Project Managers', 'General Support / Other'],
        allowOther: true, proficiency: true, levels: ['Beginner', 'Intermediate', 'Advanced'] },
      { id: 'strongest', sectionId: 's2', type: 'long_text', label: 'Briefly describe your strongest skill and how you can apply it at DIRA.', required: false, maxLength: 2000 },
      { id: 'cv', sectionId: 's2', type: 'file', label: 'Upload your CV (optional)', helpText: 'PDF, Word or RTF. Upload 1 supported file, maximum 4 MB.', required: false, accept: ['.pdf', '.doc', '.docx', '.rtf'], maxMB: 4 },
      { id: 'additional', sectionId: 's2', type: 'long_text', label: 'What additional skills do you have that you are confident will contribute to DIRA?', required: true, maxLength: 2000 },
      { id: 'links', sectionId: 's2', type: 'long_text', label: 'Provide links to your portfolio, LinkedIn or other relevant professional profiles (if any).', required: false, maxLength: 1000 },
      { id: 'interview', sectionId: 's2', type: 'single_choice', label: 'After a demo period, you will be interviewed before becoming a core team member of DIRA. Do you consent to this?', required: true, options: ['Yes', 'No'] },
      { id: 'social', sectionId: 's2', type: 'single_choice', label: 'Do you accept to follow all our social media pages and engage with our content, sharing and reposting where necessary?', required: true, options: ['Yes', 'No'] },

      { id: 'hours', sectionId: 's3', type: 'single_choice', label: 'How many hours per week can you commit?', required: false, options: ['1-3 hours', '4-7 hours', '8-12 hours', '13+ hours'] },
      { id: 'commitment', sectionId: 's3', type: 'single_choice', label: "I agree to comply with DIRA's rules, maintain professionalism, meet deadlines, and respect confidentiality.", required: false, options: ['Yes, I agree', 'No, I cannot commit'] },
      { id: 'experience', sectionId: 's3', type: 'long_text', label: 'Have you volunteered or worked on similar projects before? If yes, please explain briefly.', required: false, maxLength: 2000 },

      { id: 'motivation', sectionId: 's4', type: 'long_text', label: 'Why do you want to join DIRA? What motivates you?', required: false, maxLength: 2000 },
      { id: 'heard', sectionId: 's4', type: 'single_choice', label: 'How did you find out about DIRA?', required: true,
        options: ['LinkedIn', 'Official website', 'Google business page', 'Instagram', 'TikTok', 'X (formerly Twitter)', 'YouTube', 'From a friend', 'From a colleague at work', 'From a campaign or advert event'], allowOther: true },

      { id: 'deadlines', sectionId: 's5', type: 'long_text', label: 'If assigned tasks, how will you ensure deadlines are met?', required: false, maxLength: 2000 },
      { id: 'emergency', sectionId: 's5', type: 'short_text', label: 'Emergency Contact (Name + Phone)', required: false, maxLength: 200 }
    ]
  };

  /* ------------------------------------------------------------ helpers */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function str(v) { return v == null ? '' : String(v); }

  function normalizeForm(cfg) {
    var f = Object.assign(clone(DEFAULT_FORM), cfg || {});
    f.sections = Array.isArray(cfg && cfg.sections) && cfg.sections.length ? cfg.sections : clone(DEFAULT_FORM.sections);
    f.questions = Array.isArray(cfg && cfg.questions) ? cfg.questions : clone(DEFAULT_FORM.questions);
    var secIds = {}; var seenS = {};
    f.sections = f.sections.filter(function (s) { return s && s.id && !seenS[s.id] && (seenS[s.id] = true); }).map(function (s) {
      secIds[s.id] = true; return { id: str(s.id), title: str(s.title) || 'Untitled section', description: str(s.description) };
    });
    if (!f.sections.length) { f.sections = clone(DEFAULT_FORM.sections); f.sections.forEach(function (s) { secIds[s.id] = true; }); }
    var seenQ = {};
    f.questions = f.questions.filter(function (q) { return q && q.id && TYPES[q.type] && !seenQ[q.id] && (seenQ[q.id] = true); }).map(function (q) {
      var o = Object.assign({}, q);
      o.sectionId = secIds[o.sectionId] ? o.sectionId : f.sections[0].id;
      o.label = str(o.label) || 'Untitled question';
      o.required = !!o.required;
      if (CHOICE_TYPES.indexOf(o.type) !== -1) { o.options = Array.isArray(o.options) ? o.options.map(str).filter(Boolean) : []; }
      if (o.type === 'multi_choice' && o.proficiency) o.levels = (Array.isArray(o.levels) && o.levels.length ? o.levels : DEFAULT_FORM.questions[7].levels).map(str).filter(Boolean);
      return o;
    });
    return f;
  }

  /* ------------------------------------------------------------ answers: checking and display */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^[+0-9 ()\-]{6,30}$/;

  // Returns an error message, or '' when the answer is acceptable.
  // answer shapes: text/date -> string; single_choice/dropdown -> {value, other}; multi_choice -> [{label, level, other}]; file -> File|null
  function checkAnswer(q, a) {
    var name = '"' + q.label + '"';
    if (TEXT_TYPES.indexOf(q.type) !== -1 || q.type === 'date') {
      var v = str(a).trim();
      if (!v) return q.required ? 'Answer ' + name + '.' : '';
      if (q.type === 'email' && !EMAIL_RE.test(v)) return 'Enter a valid email address for ' + name + '.';
      if (q.type === 'phone' && !PHONE_RE.test(v)) return 'Enter a valid phone number for ' + name + ', or leave it empty.';
      if (q.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) return 'Enter a valid date for ' + name + '.';
        if (q.dateRule === 'past' && (v < '1920-01-01' || v > new Date().toISOString().slice(0, 10))) return 'Check the date for ' + name + '.';
      }
      var max = q.maxLength || (q.type === 'long_text' ? 5000 : 300);
      if (v.length > max) return name + ' is too long (maximum ' + max + ' characters).';
      return '';
    }
    if (q.type === 'single_choice' || q.type === 'dropdown') {
      var val = a && a.value ? a.value : '';
      if (!val) return q.required ? 'Choose an answer for ' + name + '.' : '';
      if (val === '__other__' && !str(a.other).trim()) return 'Tell us more for the "Other" answer to ' + name + '.';
      return '';
    }
    if (q.type === 'multi_choice') {
      var list = Array.isArray(a) ? a : [];
      if (!list.length) return q.required ? 'Select at least one answer for ' + name + '.' : '';
      for (var i = 0; i < list.length; i++) {
        if (list[i].label === '__other__' && !str(list[i].other).trim()) return 'Describe the "Other" answer for ' + name + '.';
        if (q.proficiency && !list[i].level) return 'Select a level for every choice in ' + name + '.';
      }
      return '';
    }
    if (q.type === 'file') {
      if (!a) return q.required ? 'Upload a file for ' + name + '.' : '';
      var accept = (q.accept && q.accept.length ? q.accept : ['.pdf', '.doc', '.docx', '.rtf']).map(function (x) { return x.toLowerCase(); });
      var ext = '.' + String(a.name).split('.').pop().toLowerCase();
      if (accept.indexOf(ext) === -1) return 'The file for ' + name + ' must be one of: ' + accept.join(', ') + '.';
      if (a.size > (q.maxMB || 4) * 1024 * 1024) return 'The file for ' + name + ' is larger than ' + (q.maxMB || 4) + ' MB.';
      if (a.size === 0) return 'The file for ' + name + ' is empty.';
    }
    return '';
  }

  // Turns a raw answer into the value that is stored (a string, an array of {label, level}, or file metadata).
  function storeValue(q, a) {
    if (TEXT_TYPES.indexOf(q.type) !== -1 || q.type === 'date') return str(a).trim();
    if (q.type === 'single_choice' || q.type === 'dropdown') {
      if (!a || !a.value) return '';
      return a.value === '__other__' ? 'Other: ' + str(a.other).trim() : a.value;
    }
    if (q.type === 'multi_choice') {
      return (Array.isArray(a) ? a : []).map(function (x) {
        var item = { label: x.label === '__other__' ? 'Other: ' + str(x.other).trim() : x.label };
        if (x.level) item.level = x.level;
        return item;
      });
    }
    if (q.type === 'file') return a ? { name: a.name, size: a.size, type: a.type || '' } : null;
    return '';
  }

  function displayValue(entry) {
    var v = entry.value;
    if (entry.type === 'multi_choice') return (v || []).map(function (x) { return x.level ? x.label + ' (' + x.level + ')' : x.label; }).join('; ');
    if (entry.type === 'file') return v && v.name ? v.name : '';
    return str(v);
  }

  /* ------------------------------------------------------------ IndexedDB (browser mode) */
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('This browser cannot store registrations (IndexedDB is unavailable).')); return; }
      var req = global.indexedDB.open('dira-volunteer', 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('submissions')) db.createObjectStore('submissions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open the local database.')); };
    });
    return dbPromise;
  }
  function run(storeNames, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, mode);
        var out;
        try { out = fn(tx); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error || new Error('Database error.')); };
        tx.onabort = function () { reject(tx.error || new Error('The browser refused to save (storage may be full).')); };
      });
    });
  }
  function reqResult(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  /* ------------------------------------------------------------ API helpers */
  function apiFetch(path, opts) {
    return fetch(API + path, Object.assign({ credentials: 'same-origin' }, opts || {})).then(function (r) {
      if (r.status === 401) {
        global.dispatchEvent(new CustomEvent('dira-volunteer-auth-required'));
      }
      if (!r.ok) return r.text().then(function (t) {
        var msg = 'Request failed (' + r.status + ').';
        try { var j = JSON.parse(t); if (j && j.error) msg = j.error; } catch (e) { /* not json */ }
        throw new Error(msg);
      });
      return r;
    });
  }

  /* ------------------------------------------------------------ public: form definition */
  function getForm() {
    if (MODE === 'api') {
      return apiFetch('/volunteer-form').then(function (r) { return r.json(); }).then(normalizeForm);
    }
    try { var raw = global.localStorage.getItem(FORM_KEY); if (raw) return Promise.resolve(normalizeForm(JSON.parse(raw))); } catch (e) { /* fall through */ }
    return Promise.resolve(normalizeForm(null));
  }
  function saveForm(form) {
    var f = normalizeForm(form); f.updatedAt = new Date().toISOString();
    if (MODE === 'api') {
      return apiFetch('/volunteer-form', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }).then(function () { return f; });
    }
    try { global.localStorage.setItem(FORM_KEY, JSON.stringify(f)); } catch (e) { return Promise.reject(new Error('The browser could not save the form (storage may be full or blocked).')); }
    return Promise.resolve(f);
  }
  function resetForm() {
    if (MODE === 'api') return saveForm(clone(DEFAULT_FORM));
    try { global.localStorage.removeItem(FORM_KEY); } catch (e) { /* ignore */ }
    return Promise.resolve(normalizeForm(null));
  }

  /* ------------------------------------------------------------ public: registrations */
  // submission: { id, submittedAt, applicant, answers:[{qid,label,section,type,value}], files:{qid:{name,size,type}} }
  // files: { qid: File }
  function addSubmission(sub, files) {
    files = files || {};
    if (MODE === 'api') {
      var fd = new FormData();
      fd.append('data', JSON.stringify(sub));
      Object.keys(files).forEach(function (qid) { fd.append('file_' + qid, files[qid], files[qid].name); });
      return apiFetch('/volunteer-submissions', { method: 'POST', body: fd }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }
    return run(['submissions', 'files'], 'readwrite', function (tx) {
      tx.objectStore('submissions').put(sub);
      Object.keys(files).forEach(function (qid) { tx.objectStore('files').put(files[qid], sub.id + ':' + qid); });
    });
  }
  function listSubmissions() {
    if (MODE === 'api') return apiFetch('/volunteer-submissions').then(function (r) { return r.json(); }).then(function (j) { return Array.isArray(j) ? j : (j.submissions || []); });
    return run(['submissions'], 'readonly', function (tx) { return reqResult(tx.objectStore('submissions').getAll()); });
  }
  function removeSubmission(id) {
    if (MODE === 'api') return apiFetch('/volunteer-submissions/' + encodeURIComponent(id), { method: 'DELETE' });
    return run(['submissions', 'files'], 'readwrite', function (tx) {
      tx.objectStore('submissions').delete(id);
      var fs = tx.objectStore('files'); var cur = fs.openCursor(IDBKeyRange.bound(id + ':', id + ':\uffff'));
      cur.onsuccess = function () { var c = cur.result; if (c) { c.delete(); c.continue(); } };
    });
  }
  function clearSubmissions() {
    if (MODE === 'api') return apiFetch('/volunteer-submissions', { method: 'DELETE' });
    return run(['submissions', 'files'], 'readwrite', function (tx) { tx.objectStore('submissions').clear(); tx.objectStore('files').clear(); });
  }
  // returns a Blob
  function getFile(subId, qid, meta) {
    if (MODE === 'api') {
      return apiFetch('/volunteer-submissions/' + encodeURIComponent(subId) + '/files/' + encodeURIComponent(qid)).then(function (r) { return r.blob(); });
    }
    return run(['files'], 'readonly', function (tx) { return reqResult(tx.objectStore('files').get(subId + ':' + qid)); }).then(function (b) {
      if (!b) throw new Error('The file is not available.');
      return b;
    });
  }

  /* ------------------------------------------------------------ export */
  function csvCell(v) {
    var s = str(v).replace(/\r?\n/g, ' ');
    if (/^[=+\-@\t]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function submissionsToCsv(subs) {
    var cols = []; var seen = {};
    subs.forEach(function (s) { (s.answers || []).forEach(function (a) { var k = a.label; if (!seen[k]) { seen[k] = true; cols.push(k); } }); });
    var rows = [['Submitted'].concat(cols)];
    subs.forEach(function (s) {
      var map = {}; (s.answers || []).forEach(function (a) { map[a.label] = displayValue(a); });
      rows.push([s.submittedAt].concat(cols.map(function (c) { return map[c] || ''; })));
    });
    return '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  global.DiraVolunteer = {
    mode: MODE, TYPES: TYPES, CHOICE_TYPES: CHOICE_TYPES, TEXT_TYPES: TEXT_TYPES, DEFAULT_FORM: DEFAULT_FORM,
    clone: clone, uid: uid, normalizeForm: normalizeForm,
    checkAnswer: checkAnswer, storeValue: storeValue, displayValue: displayValue,
    getForm: getForm, saveForm: saveForm, resetForm: resetForm,
    addSubmission: addSubmission, listSubmissions: listSubmissions, removeSubmission: removeSubmission,
    clearSubmissions: clearSubmissions, getFile: getFile, submissionsToCsv: submissionsToCsv
  };
})(window);

/*
 * API MODE: endpoints your backend needs (JSON unless stated). Set window.DIRA_VOLUNTEER_API = '/api' first.
 *
 *   GET    /volunteer-form                         -> the form definition (same shape as DEFAULT_FORM above)
 *   PUT    /volunteer-form                         -> body: form definition (admin only)
 *   POST   /volunteer-submissions                  -> multipart/form-data: field "data" (JSON of the submission),
 *                                                     plus one file field per upload question, named "file_<questionId>".
 *                                                     PDF, Word and RTF uploads are limited to 4 MB per file and 4.25 MB per request.
 *   GET    /volunteer-submissions                  -> { submissions: [...] } (admin only)
 *   DELETE /volunteer-submissions/:id              -> delete one registration and its files (admin only)
 *   DELETE /volunteer-submissions                  -> delete all registrations (admin only)
 *   GET    /volunteer-submissions/:id/files/:qid   -> the uploaded file, with its real Content-Type (admin only)
 *
 * A submission looks like:
 *   { id, submittedAt, applicant: { name, email, phone },
 *     answers: [ { qid, label, section, type, value } ],
 *     files: { <questionId>: { name, size, type } } }
 */
