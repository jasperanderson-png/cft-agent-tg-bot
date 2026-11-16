// Driver registration page. Plain script (the site's CSP allows only same-origin scripts).
(function () {
  var STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
  var form = document.getElementById('lead-form');
  var errorBox = document.getElementById('form-error');
  var consentText = document.getElementById('consent-text');
  var button = form.querySelector('button[type=submit]');

  var stateSelect = form.elements.state;
  STATES.forEach(function (code) {
    var o = document.createElement('option');
    o.value = code;
    o.textContent = code;
    stateSelect.appendChild(o);
  });

  // The consent wording comes from the server, so what the driver reads is exactly what is stored.
  fetch('/api/leads/form-config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      consentText.textContent = cfg.consentText;
      document.querySelectorAll('[data-company]').forEach(function (el) { el.textContent = cfg.company; });
    })
    .catch(function () {
      consentText.textContent = 'The form could not load. Please refresh the page.';
      button.disabled = true;
    });

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; });
    });
  }

  function checked(name) {
    return Array.prototype.map.call(document.querySelectorAll('[data-name="' + name + '"] input:checked'), function (i) { return i.value; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.textContent = '';
    var f = form.elements;
    var digits = f.phone.value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    var problem =
      f.full_name.value.trim().length < 2 ? ['Please enter your full name.', f.full_name]
      : digits.length !== 10 ? ['Please enter a 10-digit US mobile number.', f.phone]
      : !f.state.value ? ['Please choose your state.', f.state]
      : !f.consent.checked ? ['Please tick the consent box so we are allowed to contact you.', f.consent]
      : null;
    if (problem) {
      errorBox.textContent = problem[0];
      problem[1].focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Sending…';
    post('/api/leads/register', {
      full_name: f.full_name.value, phone: f.phone.value, email: f.email.value, city: f.city.value, state: f.state.value, zip: f.zip.value,
      cdl_class: f.cdl_class.value, years_experience: f.years_experience.value, trucks: f.trucks.value, driver_type: checked('driver_type'), equipment: checked('equipment'),
      website: f.website.value, consent: true,
    })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'Something went wrong. Please try again.');
        form.hidden = true;
        var done = document.getElementById('done');
        done.hidden = false;
        done.focus();
      })
      .catch(function (err) {
        errorBox.textContent = err.message === 'Failed to fetch' ? 'No connection. Please try again.' : err.message;
        button.disabled = false;
        button.textContent = 'Send my details';
      });
  });

  var optForm = document.getElementById('optout-form');
  var optMsg = document.getElementById('optout-msg');
  optForm.addEventListener('submit', function (e) {
    e.preventDefault();
    post('/api/leads/optout', { contact: optForm.elements.contact.value })
      .then(function (res) {
        optMsg.textContent = res.ok ? 'Done. We will not contact this number or address again.' : res.body.error || 'Please try again.';
        if (res.ok) optForm.hidden = true;
      })
      .catch(function () { optMsg.textContent = 'No connection. Please try again.'; });
  });
})();
