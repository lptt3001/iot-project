'use strict';

const heading = document.querySelector('#login-heading');
const description = document.querySelector('#login-description');
const loginDescription = description.textContent;
const loginForm = document.querySelector('#login-form');
const registerForm = document.querySelector('#register-form');
const registerSuccess = document.querySelector('#register-success');
const switchPrompt = document.querySelector('#login-switch-prompt');
const switchButton = document.querySelector('#login-switch-button');

function setPasswordVisibility(button, revealed) {
  const fieldIds = button.getAttribute('aria-controls').split(' ');
  for (const id of fieldIds) {
    document.getElementById(id).type = revealed ? 'text' : 'password';
  }
  button.textContent = revealed ? 'Ẩn' : 'Hiện';
  button.setAttribute('aria-label', revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
}

function showRegistration(registering) {
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  heading.textContent = registering ? 'Đăng ký' : 'Đăng nhập';
  description.textContent = registering
    ? 'Tạo tài khoản để theo dõi khu vườn sau khi được quản trị viên duyệt.'
    : loginDescription;
  document.title = `${heading.textContent} · PTIT Garden`;
  switchPrompt.textContent = registering ? 'Đã có tài khoản?' : 'Chưa có tài khoản?';
  switchButton.textContent = registering ? 'Quay lại đăng nhập' : 'Đăng ký';
  registerSuccess.hidden = true;
}

for (const form of [loginForm, registerForm]) {
  const registering = form === registerForm;
  const { username, password, confirmPassword } = form.elements;
  const togglePassword = form.querySelector('.login-password-toggle');
  const submitButton = form.querySelector('button[type="submit"]');
  const submitLabel = submitButton.textContent;
  const errorMessage = form.querySelector('.login-error');

  togglePassword.addEventListener('click', () => {
    setPasswordVisibility(togglePassword, password.type === 'password');
  });

  switchButton.addEventListener('click', () => {
    errorMessage.hidden = true;
    password.value = '';
    if (confirmPassword) confirmPassword.value = '';
    setPasswordVisibility(togglePassword, false);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitButton.disabled) return;

    errorMessage.hidden = true;
    if (registering && password.value !== confirmPassword.value) {
      errorMessage.textContent = 'Mật khẩu nhập lại chưa khớp.';
      errorMessage.hidden = false;
      confirmPassword.focus();
      return;
    }

    submitButton.disabled = true;
    switchButton.disabled = true;
    submitButton.textContent = registering ? 'Đang gửi đăng ký…' : 'Đang đăng nhập…';
    const submittedUsername = username.value.trim();

    try {
      const response = await fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Garden-Request': '1' },
        body: JSON.stringify({ username: submittedUsername, password: password.value }),
      });
      const result = await response.json().catch(() => null);
      if (registering && response.ok && result?.status === 'pending') {
        form.reset();
        setPasswordVisibility(togglePassword, false);
        showRegistration(false);
        loginForm.elements.username.value = result.username || submittedUsername;
        registerSuccess.textContent = 'Đã gửi đăng ký. Bạn có thể đăng nhập sau khi quản trị viên duyệt tài khoản.';
        registerSuccess.hidden = false;
        registerSuccess.focus();
        return;
      }
      if (!registering && response.ok && result?.ok) {
        window.location.replace('/' + window.location.hash);
        return;
      }

      errorMessage.textContent = typeof result?.detail === 'string'
        ? result.detail
        : registering
          ? 'Chưa gửi được đăng ký. Vui lòng thử lại.'
          : 'Chưa đăng nhập được. Vui lòng thử lại.';
      if (!registering && response.status === 401) password.select();
    } catch {
      errorMessage.textContent = 'Chưa kết nối được với PTIT Garden. Vui lòng thử lại.';
    } finally {
      submitButton.disabled = false;
      switchButton.disabled = false;
      submitButton.textContent = submitLabel;
    }

    errorMessage.hidden = false;
  });
}

switchButton.addEventListener('click', () => {
  showRegistration(registerForm.hidden);
  heading.focus();
});
document.querySelector('#login-switch').hidden = false;
