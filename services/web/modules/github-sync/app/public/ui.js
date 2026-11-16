/* Injected into the project dashboard: "GitHub Sync" (push) and
 * "Pull from GitHub" (destructive — requires typing "confirm") next to
 * "New project". */
;(function () {
  var PUSH_ID = 'github-sync-button'
  var PULL_ID = 'github-sync-pull-button'

  function toast(message, ok) {
    var el = document.getElementById('github-sync-toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'github-sync-toast'
      el.style.cssText =
        'position:fixed;top:1rem;right:1rem;z-index:10000;padding:0.75rem 1rem;' +
        'border-radius:6px;font:14px system-ui,sans-serif;color:#fff;max-width:28rem;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.15)'
      document.body.appendChild(el)
    }
    el.textContent = message
    el.style.background = ok ? '#138a07' : '#b3261e'
    el.style.display = 'block'
    clearTimeout(el._timer)
    el._timer = setTimeout(function () {
      el.style.display = 'none'
    }, ok ? 4000 : 8000)
  }

  function csrfToken() {
    var meta = document.querySelector('meta[name="ol-csrfToken"]')
    return meta ? meta.getAttribute('content') : ''
  }

  function postJson(url) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {}
        })
        .then(function (body) {
          if (!res.ok) {
            throw new Error(body && body.message ? body.message : 'HTTP ' + res.status)
          }
          return body
        })
    })
  }

  function requireBinding() {
    return fetch('/user/github-sync/status', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status)
        return res.json()
      })
      .then(function (status) {
        if (!status.bound) {
          window.location.href = '/user/github-sync'
          return null
        }
        return status
      })
  }

  /* Type-to-confirm dialog. Resolves true only when the user types "confirm". */
  function confirmPullDialog() {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div')
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(17,24,39,.45);z-index:10001;' +
        'display:flex;align-items:center;justify-content:center'

      var card = document.createElement('div')
      card.style.cssText =
        'background:#fff;border-radius:10px;padding:1.5rem 1.75rem;width:28rem;' +
        'font:14px system-ui,sans-serif;color:#111827;box-shadow:0 10px 40px rgba(0,0,0,.25)'

      card.innerHTML =
        '<h3 style="margin:0 0 .5rem;font-size:1.05rem">Pull from GitHub</h3>' +
        '<p style="margin:0 0 1rem;line-height:1.5">This <strong>overwrites</strong> matching ' +
        'files in your Overleaf projects with the repository content. Local changes that were ' +
        'not pushed are lost.</p>' +
        '<p style="margin:0 0 .4rem">Type <code style="background:#f3f4f6;padding:.1rem .3rem;' +
        'border-radius:3px">confirm</code> to continue:</p>' +
        '<input id="github-sync-confirm-input" autocomplete="off" ' +
        'style="width:100%;box-sizing:border-box;padding:.5rem .6rem;border:1px solid #d1d5db;' +
        'border-radius:6px;font:inherit;margin-bottom:.3rem">' +
        '<p id="github-sync-confirm-error" style="color:#b3261e;margin:.2rem 0 .8rem;' +
        'min-height:1rem;font-size:.85rem"></p>' +
        '<div style="display:flex;justify-content:flex-end;gap:.5rem">' +
        '<button id="github-sync-cancel" style="background:#e5e7eb;color:#111827;border:0;' +
        'border-radius:999px;padding:.45rem 1rem;font-weight:600;cursor:pointer">Cancel</button>' +
        '<button id="github-sync-ok" style="background:#b3261e;color:#fff;border:0;' +
        'border-radius:999px;padding:.45rem 1rem;font-weight:600;cursor:pointer">Pull</button>' +
        '</div>'

      overlay.appendChild(card)
      document.body.appendChild(overlay)
      var input = card.querySelector('#github-sync-confirm-input')
      var error = card.querySelector('#github-sync-confirm-error')
      input.focus()

      function close(result) {
        overlay.remove()
        resolve(result)
      }

      card.querySelector('#github-sync-cancel').addEventListener('click', function () {
        close(false)
      })
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) close(false)
      })
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') close(false)
      })
      card.querySelector('#github-sync-ok').addEventListener('click', function () {
        if (input.value.trim().toLowerCase() !== 'confirm') {
          error.textContent = 'Please type "confirm" exactly.'
          input.focus()
          return
        }
        close(true)
      })
    })
  }

  function onPush(event) {
    event.preventDefault()
    requireBinding()
      .then(function (status) {
        if (!status) return
        toast('Syncing to GitHub…', true)
        return postJson('/user/github-sync/sync').then(function (body) {
          toast(
            body.pushed
              ? 'Pushed: ' + body.projects + ' project(s), ' + body.changed + ' changed'
              : 'Already up to date (' + body.projects + ' project(s))',
            true
          )
        })
      })
      .catch(function (err) {
        toast('GitHub sync failed: ' + err.message, false)
      })
  }

  function onPull(event) {
    event.preventDefault()
    confirmPullDialog().then(function (confirmed) {
      if (!confirmed) return
      requireBinding()
        .then(function (status) {
          if (!status) return
          toast('Pulling from GitHub…', true)
          return postJson('/user/github-sync/pull').then(function (body) {
            toast(
              'Pulled: ' + body.updated + ' updated, ' + body.created + ' created',
              true
            )
          })
        })
        .catch(function (err) {
          toast('GitHub pull failed: ' + err.message, false)
        })
    })
  }

  function makeButton(id, label, onClick) {
    var button = document.createElement('button')
    button.id = id
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  function mount() {
    if (document.getElementById(PUSH_ID)) return
    var buttons = Array.prototype.slice.call(document.querySelectorAll('a, button'))
    var newProject = buttons.find(function (el) {
      return /new project/i.test((el.textContent || '').trim())
    })
    if (!newProject || !newProject.parentElement) return

    var push = makeButton(PUSH_ID, 'GitHub Sync', onPush)
    push.className = newProject.className
    push.style.marginRight = '0.75rem'

    var pull = makeButton(PULL_ID, 'Pull from GitHub', onPull)
    pull.className = newProject.className
    pull.style.marginRight = '0.75rem'
    pull.style.background = '#b3261e'

    newProject.parentElement.insertBefore(push, newProject)
    newProject.parentElement.insertBefore(pull, newProject)
  }

  var observer = new MutationObserver(function () {
    mount()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('load', mount)
  mount()
})()
