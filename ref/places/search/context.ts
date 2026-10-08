import pino from 'pino'

// Module-level logger, defaults to a basic pino instance.
// The calling product can inject its own logger via setLogger() before invoking search functions.
let _logger: pino.Logger = pino({ name: 'search' })

export const getLogger = (): pino.Logger => _logger
export const setLogger = (l: pino.Logger) => { _logger = l }
