package com.legoapilogger

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.net.URL
import java.util.regex.Pattern

object LegoAPILoggerStore {
    /**
     * Newest-last ring of captured logs.
     *
     * Every access must hold [logsLock]: `addLog` runs on OkHttp's dispatcher
     * threads (many at once), while `getLogs` / `clearLogs` run on the React
     * Native bridge thread. An unsynchronized list corrupts its size/backing
     * array under that access pattern and throws ArrayIndexOutOfBoundsException.
     */
    private val logs = ArrayDeque<HashMap<String, Any?>>()
    private val logsLock = Any()

    /**
     * Cap on retained logs. Each entry holds a full response body, so an
     * uncapped list is an unbounded memory leak on a long-running session.
     * Matches the cap the JS screen already applies to its live feed.
     */
    private const val MAX_LOGS = 500

    internal var domainRegexes: List<Pattern>? = null
    internal var pathRegexes: List<Pattern>? = null

    @Volatile
    var eventEmitter: ((WritableMap) -> Unit)? = null

    @Volatile
    internal var loggingEnabled: Boolean = false

    fun addLog(log: WritableMap) {
        val snapshot = log.toHashMap()
        synchronized(logsLock) {
            logs.addLast(snapshot)
            // Trim from the front so the newest entries survive.
            while (logs.size > MAX_LOGS) {
                logs.removeFirst()
            }
        }
        // Emit outside the lock: the callback hops to the bridge and must not
        // block other interceptor threads from recording. Read into a local so
        // a concurrent `eventEmitter = null` can't null it between check and call.
        val emit = eventEmitter
        if (emit != null) {
            try {
                emit(log)
            } catch (e: Exception) {
                // A listener that throws must not kill the OkHttp dispatcher
                // thread and, with it, the host app's request.
                Log.e("RNLegoApp", "LegoAPILoggerStore::addLog emit failed: ${e.localizedMessage}")
            }
        }
    }

    fun isValidRequest(requestUrl: String): Boolean {
        try {
            val urlObj = URL(requestUrl)
            val domain = urlObj.host
            val path = urlObj.path

            if (domainRegexes != null && domainRegexes!!.isNotEmpty()
                && domainRegexes!!.none { it.matcher(domain).matches() }
            ) {
                return false
            }
            if (pathRegexes != null && pathRegexes!!.isNotEmpty()
                && pathRegexes!!.none { it.matcher(path).matches() }
            ) {
                return false
            }
            Log.d("RNLegoApp", "LegoAPILoggerStore::addLog domain: $domain path: $path")
        } catch (e: Exception) {
            Log.e("RNLegoApp", "LegoAPILoggerStore::addLog ${e.localizedMessage}")
            return false
        }
        return true
    }

    fun clearLogs() {
        Log.d("RNLegoApp", "LegoAPILoggerStore::clearLogs")
        synchronized(logsLock) {
            logs.clear()
        }
    }

    fun getLogs(): WritableArray {
        // Copy under the lock, then convert outside it: iterating the live list
        // while an interceptor thread appends throws ConcurrentModification,
        // and the conversion itself is slow enough to stall request logging.
        val snapshots = synchronized(logsLock) { logs.toList() }
        return Arguments.createArray().apply {
            snapshots.forEach { snapshot ->
                pushMap(toWritableMap(snapshot))
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun toWritableMap(map: Map<String, Any?>): WritableMap {
        return Arguments.createMap().also { out ->
            map.forEach { (key, value) ->
                when (value) {
                    null -> out.putNull(key)
                    is Boolean -> out.putBoolean(key, value)
                    is Int -> out.putInt(key, value)
                    is Long -> out.putDouble(key, value.toDouble())
                    is Float -> out.putDouble(key, value.toDouble())
                    is Double -> out.putDouble(key, value)
                    is String -> out.putString(key, value)
                    is Map<*, *> -> out.putMap(key, toWritableMap(value as Map<String, Any?>))
                    is List<*> -> out.putArray(key, toWritableArray(value))
                    else -> out.putString(key, value.toString())
                }
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun toWritableArray(list: List<*>): WritableArray {
        return Arguments.createArray().also { out ->
            list.forEach { item ->
                when (item) {
                    null -> out.pushNull()
                    is Boolean -> out.pushBoolean(item)
                    is Int -> out.pushInt(item)
                    is Long -> out.pushDouble(item.toDouble())
                    is Float -> out.pushDouble(item.toDouble())
                    is Double -> out.pushDouble(item)
                    is String -> out.pushString(item)
                    is Map<*, *> -> out.pushMap(toWritableMap(item as Map<String, Any?>))
                    is List<*> -> out.pushArray(toWritableArray(item))
                    else -> out.pushString(item.toString())
                }
            }
        }
    }
}
