/*
 * Sign a test in to the console the way a browser does.
 *
 * The console's API needs an administrator session, and the end-to-end tests
 * assert against it. They provision and sign in rather than switching the
 * guard off: a flag that disables authentication is the kind of thing that
 * exists "only for tests" until the day it does not, and an appliance whose
 * admin API can be opened by an environment variable is worse than one whose
 * tests are slightly longer.
 */

/**
 * @returns {Promise<{cookie:string, fetch:Function}>} a cookie header and a
 *   fetch bound to it, so a test can call the API as the administrator.
 */
export async function signIn(base, { username = 'admin', password = 'test administrator password' } = {}) {
  // First run provisions; a later one signs in. Which of the two it is depends
  // on whether this test's data directory already has an account.
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  const route = status.provisioned ? 'login' : 'provision';

  const res = await fetch(`${base}/api/auth/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`could not sign in to the console (${route} ${res.status}): ${body.slice(0, 200)}`);
  }

  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (!cookie.startsWith('hajiz_session=')) {
    throw new Error(`sign-in returned no session cookie: ${setCookie.slice(0, 120)}`);
  }

  return {
    cookie,
    fetch: (url, init = {}) =>
      fetch(url, { ...init, headers: { ...(init.headers ?? {}), cookie } }),
  };
}
