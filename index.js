'use strict'

const { resolve: urlResolve } = require('url')
const normalizeUrl = require('normalize-url')
const { parse } = require('querystring')
const prettyMs = require('pretty-ms')
const computeEtag = require('etag')
const assert = require('assert')
const { URL } = require('url')
const Keyv = require('keyv')

const { decompress: brotliDecompress, compress: brotliCompress } = require('iltorb')

const getEtag = data => computeEtag(typeof data === 'string' ? data : JSON.stringify(data))

const getKey = url => {
  const { origin } = new URL(url)
  const baseKey = normalizeUrl(url, {
    removeQueryParameters: [/^utm_\w+/i, 'force', 'filter', 'ref']
  })
  return baseKey.replace(origin, '').replace('/?', '')
}

const toSeconds = ms => Math.floor(ms / 1000)

const createSetHeaders = ({ revalidate }) => {
  return ({ res, createdAt, isHit, ttl, hasForce, etag }) => {
    // Specifies the maximum amount of time a resource
    // will be considered fresh in seconds
    const diff = hasForce ? 0 : createdAt + ttl - Date.now()
    const maxAge = toSeconds(diff)

    res.setHeader(
      'Cache-Control',
      `public, must-revalidate, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${
        hasForce ? 0 : toSeconds(revalidate(ttl))
      }`
    )

    res.setHeader('X-Cache-Status', isHit ? 'HIT' : 'MISS')
    res.setHeader('X-Cache-Expired-At', prettyMs(diff))
    res.setHeader('ETag', etag)
  }
}

module.exports = ({
  cache = new Keyv({ namespace: 'ssr' }),
  compress = false,
  get,
  send,
  revalidate = ttl => ttl / 24,
  ttl: defaultTtl = 7200000
} = {}) => {
  assert(get, '.get required')
  assert(send, '.send required')

  const setHeaders = createSetHeaders({
    revalidate: typeof revalidate === 'function' ? revalidate : () => revalidate
  })

  return async ({ req, res, ...opts }) => {
    const hasForce = Boolean(req.query ? req.query.force : parse(req.url.split('?')[1]).force)
    const url = urlResolve('http://localhost', req.url)
    const key = getKey(url)

    const cachedData = await cache.get(key)
    const hasData = cachedData !== undefined
    const isHit = !hasForce && hasData

    const cachedResult =
      compress && hasData ? JSON.parse(await brotliDecompress(cachedData)) : cachedData

    const { etag: cachedEtag, ttl = defaultTtl, createdAt = Date.now(), data, ...props } = isHit
      ? cachedResult
      : await get({ req, res, ...opts })

    const etag = cachedEtag || getEtag(data)

    setHeaders({
      etag,
      res,
      createdAt,
      isHit,
      ttl,
      hasForce
    })

    if (!isHit) {
      const payload = { etag, createdAt, ttl, data, ...props }
      const value = compress ? await brotliCompress(Buffer.from(JSON.stringify(payload))) : payload
      await cache.set(key, value, ttl)
    }

    send({ data, res, req, ...props })
  }
}

module.exports.getKey = getKey
