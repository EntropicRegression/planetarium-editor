#!/usr/bin/env python3
"""Local helper for the spatial wallpaper editor. Python 3.8+, standard library only.

    python serve.py            # then open http://127.0.0.1:8765
    python serve.py --port 9000 --open

The editor is a static page and works without this (open index.html). The helper adds what a
page cannot do by itself:

  * "Sign in with ChatGPT": OpenAI sends the sign-in back to a loopback address, so something
    has to listen there. The helper runs that exchange and keeps the tokens in a file in your
    home directory; the page never sees them.
  * Reaching api.openai.com without a browser origin, for the API-key mode as well.

It listens on 127.0.0.1 only, forwards only to a fixed list of OpenAI endpoints, and refuses
requests that do not come from its own page.
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(os.path.expanduser('~'), '.planetarium-editor', 'openai.json')

# OpenAI's sign-in for locally run, open-source apps ("Sign in with ChatGPT").
AUTH_HOST = 'auth.openai.com'
AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
TOKEN_PATH = '/api/accounts/oauth/token'
API_HOST = 'api.openai.com'
RESOURCE = 'https://api.openai.com/v1'
SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
# A first sign-in registers this app and gets its own client id back, which is used from then on.
FIRST_CLIENT_ID = 'dynamic_agent_client'
APP_NAME = 'Planetarium Spatial Editor'

# The only things the page may ask the helper to forward.
FORWARDABLE = {
    ('POST', '/v1/responses'),
    ('POST', '/v1/images/generations'),
    ('POST', '/v1/images/edits'),
    ('GET', '/v1/models'),
}

lock = threading.Lock()
# The sign-in in progress: state, PKCE verifier, nonce, redirect URI, client id. One at a time.
pending = {}
# Why the last sign-in failed, shown by the page; cleared when a new one starts.
last_error = ''


# ---------------------------------------------------------------------------- stored session

def load_store():
    try:
        with open(STORE, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_store(data):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    tmp = STORE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(tmp, 0o600)  # the tokens are for this user only (no effect on Windows)
    except OSError:
        pass
    os.replace(tmp, STORE)


def claims_of(jwt):
    """The payload of a JWT, without checking its signature."""
    try:
        payload = jwt.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    except (IndexError, ValueError):
        return {}


def token_request(fields):
    """POSTs a form to OpenAI's token endpoint. Returns (status, parsed JSON body)."""
    body = urllib.parse.urlencode(fields)
    conn = http.client.HTTPSConnection(AUTH_HOST, timeout=30)
    try:
        conn.request('POST', TOKEN_PATH, body, {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'})
        response = conn.getresponse()
        raw = response.read()
    finally:
        conn.close()
    try:
        return response.status, json.loads(raw)
    except ValueError:
        return response.status, {'error': raw[:300].decode('utf-8', 'replace')}


def describe(body):
    error = body.get('error')
    if isinstance(error, dict):
        return error.get('message') or json.dumps(error)
    return body.get('error_description') or error or 'unknown error'


def keep_tokens(store, tokens):
    store['access_token'] = tokens['access_token']
    # Refresh tokens rotate: each use returns the next one, and the old one stops working.
    if tokens.get('refresh_token'):
        store['refresh_token'] = tokens['refresh_token']
    if tokens.get('id_token'):
        store['id_token'] = tokens['id_token']
    store['expires_at'] = time.time() + int(tokens.get('expires_in') or 3600)
    save_store(store)


def access_token(force_refresh=False):
    """A usable access token, refreshed if it is about to expire. None when not signed in."""
    with lock:
        store = load_store()
        if not store.get('access_token'):
            return None
        if not force_refresh and store.get('expires_at', 0) - time.time() > 120:
            return store['access_token']
        if not store.get('refresh_token'):
            return None if force_refresh else store['access_token']
        status, body = token_request({
            'grant_type': 'refresh_token',
            'client_id': store['client_id'],
            'refresh_token': store['refresh_token'],
            'resource': RESOURCE,
        })
        if status != 200 or 'access_token' not in body:
            # The sign-in has lapsed (refresh tokens last 30 days) or was revoked.
            for key in ('access_token', 'refresh_token', 'id_token', 'expires_at'):
                store.pop(key, None)
            save_store(store)
            return None
        keep_tokens(store, body)
        return store['access_token']


def session_status():
    store = load_store()
    claims = claims_of(store.get('id_token', ''))
    return {
        'signedIn': bool(store.get('access_token')),
        'account': claims.get('email') or claims.get('name') or '',
        'error': last_error,
    }


# ---------------------------------------------------------------------------- sign-in

def start_sign_in(port):
    global last_error
    with lock:
        store = load_store()
        if not store.get('host_id'):
            store['host_id'] = secrets.token_hex(16)  # identifies this installation to OpenAI
            save_store(store)
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b'=').decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        client_id = store.get('client_id') or FIRST_CLIENT_ID
        pending.clear()
        pending.update({
            'state': secrets.token_urlsafe(24),
            'nonce': secrets.token_urlsafe(24),
            'verifier': verifier,
            # OpenAI accepts a loopback redirect on 127.0.0.1 (not "localhost"); only the port may vary.
            'redirect_uri': 'http://127.0.0.1:%d/auth/callback' % port,
            'client_id': client_id,
        })
        last_error = ''
        params = {
            'response_type': 'code',
            'client_id': client_id,
            'redirect_uri': pending['redirect_uri'],
            'scope': SCOPE,
            'resource': RESOURCE,
            'code_challenge': challenge,
            'code_challenge_method': 'S256',
            'state': pending['state'],
            'nonce': pending['nonce'],
        }
        if client_id == FIRST_CLIENT_ID:
            params['agent_name_hint'] = APP_NAME
            params['ext_agent_host_id'] = store['host_id']
        return AUTHORIZE_URL + '?' + urllib.parse.urlencode(params)


def finish_sign_in(query):
    """Handles OpenAI's redirect back. Returns an error message, or '' on success."""
    with lock:
        attempt = dict(pending)
        # Only the redirect that carries this sign-in's state ends it; anything else that hits
        # this address leaves the sign-in in progress untouched.
        if not attempt or not secrets.compare_digest(query.get('state', ''), attempt['state']):
            return 'This sign-in was not started from the editor, or it was started twice. Start again from the editor.'
        pending.clear()
    if query.get('error'):
        return query.get('error_description') or query['error']
    if not query.get('code'):
        return 'OpenAI sent no authorization code.'
    client_id = query.get('client_id') or attempt['client_id']
    status, body = token_request({
        'grant_type': 'authorization_code',
        'client_id': client_id,
        'code': query['code'],
        'code_verifier': attempt['verifier'],
        'redirect_uri': attempt['redirect_uri'],
        'resource': RESOURCE,
    })
    if status != 200 or 'access_token' not in body:
        return 'OpenAI refused the sign-in: %s' % describe(body)

    # The ID token came straight from OpenAI over TLS, which stands in for checking its signature
    # (OpenID Connect Core 3.1.3.7); its claims still have to be the ones this sign-in asked for.
    claims = claims_of(body.get('id_token', ''))
    if claims:
        audience = claims.get('aud')
        audiences = audience if isinstance(audience, list) else [audience]
        if claims.get('iss', '').rstrip('/') != 'https://' + AUTH_HOST:
            return 'The sign-in came from an unexpected issuer.'
        if client_id not in audiences:
            return 'The sign-in was issued for a different app.'
        if claims.get('nonce') != attempt['nonce']:
            return 'The sign-in does not match the request that started it.'
    if 'chatgpt.tokens.use.direct' not in (body.get('scope') or SCOPE).split():
        return 'This account did not grant use of its ChatGPT plan (it may not be eligible).'

    with lock:
        store = load_store()
        store['client_id'] = client_id
        keep_tokens(store, body)
    return ''


def sign_out():
    with lock:
        store = load_store()
        for key in ('access_token', 'refresh_token', 'id_token', 'expires_at'):
            store.pop(key, None)
        save_store(store)


# ---------------------------------------------------------------------------- HTTP

PAGE = """<!doctype html><meta charset="utf-8"><title>%s</title>
<body style="font:16px system-ui;background:#14151a;color:#e7e8ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;padding:24px;text-align:center"><h1 style="font-size:20px">%s</h1><p>%s</p></div>"""


class Handler(SimpleHTTPRequestHandler):
    server_version = 'SpatialEditorHelper'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format, *args):
        # Quiet: only problems are printed.
        if args and str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
            sys.stderr.write('%s %s\n' % (self.address_string(), format % args))

    # -- guards

    def own_origin(self):
        """Whether the request is addressed to, and (if it says) comes from, this helper's page."""
        port = self.server.server_address[1]
        allowed = {'127.0.0.1:%d' % port, 'localhost:%d' % port}
        if self.headers.get('Host', '') not in allowed:
            return False  # a different name pointing at 127.0.0.1 (DNS rebinding)
        origin = self.headers.get('Origin')
        return origin is None or origin in {'http://' + host for host in allowed}

    def api_allowed(self):
        # A header a plain cross-site form or link cannot set.
        return self.own_origin() and self.headers.get('x-wall-editor') == '1'

    def send_json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def send_page(self, status, title, text):
        raw = (PAGE % (title, title, text)).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    # -- routes

    def do_GET(self):
        global last_error
        url = urllib.parse.urlsplit(self.path)
        if url.path == '/auth/callback':
            if not self.own_origin():
                return self.send_page(403, 'Refused', 'This request did not come from the editor.')
            query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            try:
                error = finish_sign_in(query)
            except OSError as e:
                error = 'Could not reach OpenAI: %s' % e
            last_error = error
            if error:
                return self.send_page(400, '登入失敗', error)
            return self.send_page(200, '登入完成', '可以關閉這個分頁,回到編輯器。')
        if url.path.startswith('/api/'):
            if not self.api_allowed():
                return self.send_json(403, {'error': 'refused'})
            if url.path == '/api/status':
                return self.send_json(200, {'helper': True, 'openai': session_status()})
            if url.path.startswith('/api/openai/v1/'):
                return self.forward('GET', url.path[len('/api/openai'):])
            return self.send_json(404, {'error': 'not found'})
        # Everything else is a file of the editor. Hidden files (.git and friends) are not served.
        if any(part.startswith('.') for part in url.path.split('/') if part):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        if not url.path.startswith('/api/') or not self.api_allowed():
            return self.send_json(403, {'error': 'refused'})
        if url.path == '/api/openai/signin':
            return self.send_json(200, {'url': start_sign_in(self.server.server_address[1])})
        if url.path == '/api/openai/signout':
            sign_out()
            return self.send_json(200, {'ok': True})
        if url.path.startswith('/api/openai/v1/'):
            return self.forward('POST', url.path[len('/api/openai'):])
        return self.send_json(404, {'error': 'not found'})

    def end_headers(self):
        # The editor's own files change while it is being worked on; never serve a stale copy.
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # -- forwarding to api.openai.com

    def forward(self, method, path):
        if (method, path) not in FORWARDABLE:
            return self.send_json(404, {'error': 'this endpoint is not forwarded'})
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        use_session = self.headers.get('x-wall-auth') == 'session'

        def attempt(force_refresh):
            if use_session:
                token = access_token(force_refresh)
                if not token:
                    return None
                authorization = 'Bearer ' + token
            else:
                authorization = self.headers.get('Authorization', '')
            headers = {'Authorization': authorization, 'Accept': self.headers.get('Accept', '*/*')}
            if body is not None:
                headers['Content-Type'] = self.headers.get('Content-Type', 'application/json')
            conn = http.client.HTTPSConnection(API_HOST, timeout=600)
            conn.request(method, path, body, headers)
            return conn, conn.getresponse()

        try:
            result = attempt(False)
            if result and use_session and result[1].status == 401:
                # The token was rejected early: refresh it once and try again.
                result[0].close()
                result = attempt(True)
            if result is None:
                return self.send_json(401, {'error': {'message': 'Not signed in to ChatGPT. Sign in from the editor settings.', 'code': 'not_signed_in'}})
            conn, upstream = result
        except OSError as e:
            return self.send_json(502, {'error': {'message': 'Could not reach api.openai.com: %s' % e}})

        try:
            self.send_response(upstream.status)
            self.send_header('Content-Type', upstream.getheader('Content-Type') or 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            # Passed on as it arrives, so a streamed reply reaches the page token by token.
            while True:
                chunk = upstream.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionError):
            pass  # the page stopped listening (the person pressed Stop)
        finally:
            conn.close()


def main():
    parser = argparse.ArgumentParser(description='Serve the spatial wallpaper editor with its local helper.')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true', help='open the editor in the default browser')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    url = 'http://127.0.0.1:%d' % args.port
    print('Spatial wallpaper editor: %s   (Ctrl+C to stop)' % url, flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
