const net = require('net')
const url = require('url')
const punycode = require('punycode')
const { parseSimpleWhois, parseDomainWhois } = require('./parsers.js')
const { splitStringBy, requestGetBody, isTld, isDomain } = require('./utils.js')
require('array-flat-polyfill')

// cache
let cacheTldWhoisServer = {
	com:	'whois.verisign-grs.com',
	shop:	'whois.nic.shop'
}

// misspelled whois servers..
const misspelledWhoisServer = {
	'whois.google.com':		'whois.nic.google',
	'www.gandi.net/whois':	'whois.gandi.net',
	'who.godaddy.com/':		'whois.godaddy.com',
	'whois.godaddy.com/':	'whois.godaddy.com',
}


const whoisQuery = ({host = null, port = 43, timeout = 15000, query = '', querySuffix = "\r\n"} = {}) => {
	return new Promise((resolve, reject) => {
		let data = ''
		const socket = net.connect({host: host, port: port}, () => socket.write(query + querySuffix))
		socket.setTimeout(timeout)
		socket.on('data', chunk => data += chunk)
		socket.on('close', hadError => resolve(data))
		socket.on('timeout', () => socket.destroy(new Error('Timeout')))
		socket.on('error', reject)
	})
}


const allTlds = async () => {
	const tlds = await requestGetBody('https://data.iana.org/TLD/tlds-alpha-by-domain.txt')

	return tlds.split("\n").filter(tld => Boolean(tld) && !tld.startsWith('#'))
}


const whoisTld = async (query, {timeout = 15000} = {}) => {

	let result = await whoisQuery({
		host:	'whois.iana.org',
		query,
		timeout
	})

	const data = parseSimpleWhois(result)

	if (!data.domain || !data.domain.length) {
		throw new Error(`TLD "${query}" not found`)
	}

	return data
}


const whoisDomain = async (domain, {host = null, timeout = 15000, follow = 2} = {}) => {
	domain = punycode.toASCII(domain)
	const [domainName, domainTld] = splitStringBy(domain.toLowerCase(), domain.lastIndexOf('.'))
	let results = {}

	// find WHOIS server in cache
	if (!host && cacheTldWhoisServer[domainTld]) {
		host = cacheTldWhoisServer[domainTld]
	}

	// find WHOIS server for TLD
	if (!host) {
		const tld = await whoisTld(domain, {timeout: timeout})

		if (!tld.whois) {
			throw new Error(`TLD for "${domain}" not supported`)
		}

		host = tld.whois
		cacheTldWhoisServer[domainTld] = tld.whois
	}

	// query WHOIS servers for data
	while (host && follow) {
		let query = domain

		// hardcoded WHOIS queries..
		if (host === 'whois.denic.de') {
			query = `-T dn ${query}`
		}

		result = await whoisQuery({ host, query, timeout })
		result = parseDomainWhois(result)

		results[host] = result
		follow--

		// check for next WHOIS server
		let nextWhoisServer = result['Registrar WHOIS Server'] || result['Registry WHOIS Server'] || result['ReferralServer'] || result['Registrar Whois'] || result['Whois Server'] || result['WHOIS Server'] || false

		if (nextWhoisServer) {

			// if found, remove protocol and path
			if (nextWhoisServer.includes('://')) {
				let parsedUrl = url.parse(nextWhoisServer)
				nextWhoisServer = parsedUrl.host
			}

			// check if found server is in misspelled list
			nextWhoisServer = misspelledWhoisServer[nextWhoisServer] || nextWhoisServer

			// check if found server was queried already
			nextWhoisServer = !results[nextWhoisServer] ? nextWhoisServer : false
		}

		host = nextWhoisServer
	}

	return results
}


const whoisIpOrAsn = async (query, {host = null, timeout = 15000} = {}) => {
	let data = {}
	query = String(query)

	// find WHOIS server for IP
	if (!host) {
		let whoisResult = await whoisQuery({
			host:	'whois.iana.org',
			query,
			timeout
		})

		whoisResult = parseSimpleWhois(whoisResult)

		if (whoisResult.whois) {
			host = whoisResult.whois
		}
	}

	if (!host) {
		throw new Error(`No WHOIS server for "${query}"`)
	}

	const type = net.isIP(query) ? 'ip' : 'asn'

	// hardcoded custom queries..
	if (host === 'whois.arin.net' && type === 'ip') {
		query = `+ n ${query}`
	} else if (host === 'whois.arin.net' && type === 'asn') {
		query = `+ a ${query}`
	}

	data = await whoisQuery({ host, query, timeout })

	return parseSimpleWhois(data)
}


module.exports = (query, options) => {

	if (net.isIP(query) || /^(as)?\d+$/i.test(query)) {
		return whoisIpOrAsn(query, options)
	} else if (isTld(query)) {
		return whoisTld(query, options)
	} else if (isDomain(query)) {
		return whoisDomain(query, options)
	}

	throw new Error('Unrecognized query. Try a domain (google.com), IP (1.1.1.1) or TLD (.blog)')
}

module.exports.query = whoisQuery
module.exports.tld = whoisTld
module.exports.domain = whoisDomain
module.exports.asn = whoisIpOrAsn
module.exports.ip = whoisIpOrAsn
module.exports.allTlds = allTlds
