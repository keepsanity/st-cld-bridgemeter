// Bridge Meter
// 로컬 브리지의 /usage를 읽어 구독 사용률과 이번 세션 통계를 보여준다.

const MODULE = 'st_cld_bridgemeter'
const DEFAULTS = Object.freeze({
    url: 'http://127.0.0.1:5210',
    showBar: true,
    refreshSeconds: 60,
})
const FETCH_TIMEOUT_MS = 25_000

const ctx = SillyTavern.getContext()
const state = { data: null, error: null, loading: false, fetchedAt: null }
let timer = null

// ---------------------------------------------------------------- 설정 ----

function settings() {
    const store = ctx.extensionSettings
    // 항상 같은 객체를 돌려줘야 한다. 매번 새 객체를 만들면 화면에서 바꾼 값이 버려진다.
    if (!store[MODULE] || typeof store[MODULE] !== 'object') store[MODULE] = {}
    const s = store[MODULE]
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (s[key] === undefined) s[key] = value
    }
    return s
}

function save() {
    ctx.saveSettingsDebounced()
}

// ---------------------------------------------------------------- 조회 ----

const UNREACHABLE = '브리지에 연결할 수 없습니다. 브리지가 켜져 있는지 확인하세요.'

function isUsage(json) {
    return Boolean(json && typeof json === 'object' && typeof json.requests === 'number' && 'plan' in json)
}

/**
 * 실리태번 서버를 거쳐 읽는다. 실리태번 서버가 브리지와 같은 PC에 있으므로,
 * 휴대폰 등 다른 기기에서 실리태번을 열어도 동작한다.
 * 실리태번이 Custom 연결을 확인할 때 쓰는 경로(주소 뒤에 /models를 붙여 조회)를 그대로 이용한다.
 */
async function fetchViaServer(base, force, signal) {
    if (typeof ctx.getRequestHeaders !== 'function') return null
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: `${base}/usage${force ? '/refresh' : ''}`,
            custom_include_headers: '',
        }),
        cache: 'no-cache',
        signal,
    })
    if (!response.ok) return null
    const json = await response.json()
    return isUsage(json) ? json : null
}

/** 브라우저에서 브리지를 직접 읽는다. 실리태번과 브리지를 같은 PC에서 볼 때만 닿는다. */
async function fetchDirect(base, force, signal) {
    const response = await fetch(`${base}/usage${force ? '?refresh=1' : ''}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error(`브리지가 ${response.status} 오류를 돌려줬습니다.`)
    const json = await response.json()
    if (!isUsage(json)) throw new Error('브리지 주소가 올바르지 않습니다.')
    return json
}

async function refresh({ force = false } = {}) {
    if (state.loading) return
    state.loading = true
    render()

    const { url } = settings()
    const base = String(url || DEFAULTS.url).replace(/\/+$/, '').replace(/\/v1$/, '')
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)

    try {
        let data = null
        try {
            data = await fetchViaServer(base, force, abort.signal)
        } catch {
            // 서버 경유가 안 되면 아래에서 직접 읽어 본다.
        }
        state.data = data ?? (await fetchDirect(base, force, abort.signal))
        state.error = null
    } catch (err) {
        state.error = err instanceof TypeError || err?.name === 'AbortError' ? UNREACHABLE : String(err?.message || err)
    } finally {
        clearTimeout(timeout)
        state.loading = false
        state.fetchedAt = new Date()
        render()
    }
}

const RETRY_AFTER_FAILURE_MS = 5 * 60_000

function schedule() {
    clearInterval(timer)
    const seconds = Math.max(15, Number(settings().refreshSeconds) || DEFAULTS.refreshSeconds)
    timer = setInterval(() => {
        if (document.hidden) return
        // 브리지가 꺼져 있을 때는 자주 두드리지 않는다. (클릭하거나 답변이 끝나면 바로 다시 읽는다.)
        if (state.error && state.fetchedAt && Date.now() - state.fetchedAt.getTime() < RETRY_AFTER_FAILURE_MS) return
        refresh()
    }, seconds * 1000)
}

// ---------------------------------------------------------------- 표시 ----

function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
}

const number = value => Number(value || 0).toLocaleString('ko-KR')
const percent = value => (typeof value === 'number' ? `${Math.round(value)}%` : '–')

function level(value) {
    if (typeof value !== 'number') return ''
    if (value >= 90) return 'cbu-danger'
    if (value >= 75) return 'cbu-warn'
    return ''
}

function resetText(iso) {
    if (!iso) return ''
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return ''
    const when = at.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const minutes = Math.round((at.getTime() - Date.now()) / 60000)
    if (minutes <= 0) return `${when} 초기화`
    const d = Math.floor(minutes / 1440)
    const h = Math.floor((minutes % 1440) / 60)
    const m = minutes % 60
    const left = d > 0 ? `${d}일 ${h}시간` : h > 0 ? `${h}시간 ${m}분` : `${m}분`
    return `${when} 초기화 (${left} 뒤)`
}

function agoText(iso) {
    if (!iso) return ''
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (minutes < 1) return '방금'
    if (minutes < 60) return `${minutes}분 전`
    return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 전`
}

function meter(value) {
    const track = el('div', `cbu-meter ${level(value)}`)
    const fill = el('div', 'cbu-meter-fill')
    fill.style.width = `${Math.max(0, Math.min(100, typeof value === 'number' ? value : 0))}%`
    track.append(fill)
    return track
}

function renderBar() {
    const bar = document.getElementById('cbu_bar')
    if (!bar) return
    bar.hidden = !settings().showBar
    bar.replaceChildren()
    bar.classList.toggle('cbu-loading', state.loading)
    bar.title = state.error ? '클릭하면 다시 시도합니다' : '클릭하면 새로고침합니다'

    bar.append(el('span', 'cbu-bar-title', '사용량'))

    if (state.error) {
        bar.append(el('span', 'cbu-bar-note cbu-danger', state.error))
        return
    }

    const plan = state.data?.plan
    const windows = plan?.windows ?? []
    if (!state.data) {
        bar.append(el('span', 'cbu-bar-note', '불러오는 중…'))
    } else if (windows.length === 0) {
        bar.append(el('span', 'cbu-bar-note', plan?.error || '구독 한도 정보 없음'))
    } else {
        for (const w of windows) {
            const item = el('span', `cbu-bar-item ${level(w.utilization)}`)
            item.append(el('span', 'cbu-bar-label', w.label), meter(w.utilization), el('span', 'cbu-bar-value', percent(w.utilization)))
            item.title = resetText(w.resetsAt)
            bar.append(item)
        }
    }
}

function renderPanel() {
    const panel = document.getElementById('cbu_panel')
    if (!panel) return
    panel.replaceChildren()

    if (state.error) {
        panel.append(el('div', 'cbu-message cbu-danger', state.error))
        return
    }
    if (!state.data) {
        panel.append(el('div', 'cbu-message', '불러오는 중…'))
        return
    }

    const { plan } = state.data

    // 구독 한도
    const limits = el('div', 'cbu-section')
    const title = plan?.subscriptionType ? `구독 한도 (${plan.subscriptionType})` : '구독 한도'
    limits.append(el('div', 'cbu-section-title', title))
    const windows = plan?.windows ?? []
    if (windows.length === 0) {
        limits.append(el('div', 'cbu-message', plan?.error || '구독 한도 정보를 받지 못했습니다.'))
    }
    for (const w of windows) {
        const row = el('div', `cbu-window ${level(w.utilization)}`)
        const head = el('div', 'cbu-window-head')
        head.append(el('span', 'cbu-window-label', w.label), el('span', 'cbu-window-value', percent(w.utilization)))
        row.append(head, meter(w.utilization), el('div', 'cbu-window-reset', resetText(w.resetsAt)))
        limits.append(row)
    }
    if (plan?.error && windows.length > 0) limits.append(el('div', 'cbu-message cbu-warn', `갱신 실패: ${plan.error}`))
    panel.append(limits)

    // 브리지를 켠 뒤의 누적
    const session = el('div', 'cbu-section')
    session.append(el('div', 'cbu-section-title', '브리지를 켠 뒤'))
    const grid = el('div', 'cbu-grid')
    const stat = (label, value) => {
        const cell = el('div', 'cbu-stat')
        cell.append(el('div', 'cbu-stat-value', value), el('div', 'cbu-stat-label', label))
        grid.append(cell)
    }
    const input = (state.data.inputTokens || 0) + (state.data.cacheReadTokens || 0) + (state.data.cacheWriteTokens || 0)
    stat('요청', state.data.failures ? `${number(state.data.requests)} (실패 ${number(state.data.failures)})` : number(state.data.requests))
    stat('입력 토큰', number(input))
    stat('출력 토큰', number(state.data.outputTokens))
    stat('API 정가 환산', `$${Number(state.data.costUsd || 0).toFixed(2)}`)
    session.append(grid)

    const last = state.data.lastRequest
    if (last) {
        const text = `마지막 요청: ${last.model} · ${agoText(last.at)} · ${last.seconds}초 · 입력 ${number(last.inputTokens)} / 출력 ${number(last.outputTokens)}${last.ok ? '' : ' · 실패'}`
        session.append(el('div', 'cbu-last', text))
    }
    panel.append(session)

    if (state.fetchedAt) {
        panel.append(el('div', 'cbu-updated', `갱신: ${state.fetchedAt.toLocaleTimeString('ko-KR')}`))
    }
}

function render() {
    renderBar()
    renderPanel()
    document.getElementById('cbu_refresh')?.classList.toggle('disabled', state.loading)
}

// ---------------------------------------------------------------- 화면 ----

function field(labelText, input) {
    const label = el('label', 'cbu-field')
    label.append(el('span', null, labelText), input)
    return label
}

function buildSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings')
    if (!host || document.getElementById('cbu_settings')) return
    const s = settings()

    const root = el('div', 'cbu-settings')
    root.id = 'cbu_settings'
    const drawer = el('div', 'inline-drawer')
    const header = el('div', 'inline-drawer-toggle inline-drawer-header')
    header.append(el('b', null, 'Bridge Meter'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'))
    const content = el('div', 'inline-drawer-content')

    const panel = el('div', 'cbu-panel')
    panel.id = 'cbu_panel'

    const refreshButton = el('div', 'menu_button', '새로고침')
    refreshButton.id = 'cbu_refresh'
    refreshButton.addEventListener('click', () => refresh({ force: true }))

    const url = el('input', 'text_pole')
    url.type = 'text'
    url.value = s.url
    url.placeholder = DEFAULTS.url
    url.addEventListener('change', () => {
        s.url = url.value.trim() || DEFAULTS.url
        save()
        refresh()
    })

    const showBar = el('input')
    showBar.type = 'checkbox'
    showBar.checked = Boolean(s.showBar)
    showBar.addEventListener('change', () => {
        s.showBar = showBar.checked
        save()
        renderBar()
    })
    const showBarLabel = el('label', 'checkbox_label')
    showBarLabel.append(showBar, el('span', null, '입력창 위에 한 줄로 표시'))

    content.append(panel, refreshButton, field('브리지 주소 (실리태번을 실행하는 PC 기준)', url), showBarLabel)
    drawer.append(header, content)
    root.append(drawer)
    host.append(root)
}

function buildBar() {
    const form = document.getElementById('form_sheld')
    if (!form || document.getElementById('cbu_bar')) return
    const bar = el('div', 'cbu-bar')
    bar.id = 'cbu_bar'
    bar.addEventListener('click', () => refresh({ force: true }))
    form.prepend(bar)
}

function init() {
    settings()
    buildSettings()
    buildBar()
    render()
    refresh()
    schedule()

    // 답변이 끝나면 조금 뒤에 사용률을 다시 읽는다.
    const { eventSource, eventTypes } = ctx
    if (eventSource && eventTypes?.GENERATION_ENDED) {
        eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(() => refresh(), 1500))
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !state.error) refresh()
    })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
