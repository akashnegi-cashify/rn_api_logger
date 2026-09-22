import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  LegoApiLogger,
  isLegoApiLoggerAvailable,
  parseLog,
} from './LegoApiLogger';
import type { ApiLog } from './types';
import { ApiLoggerHeader } from './ApiLoggerHeader';

export interface ApiLoggerScreenProps {
  /**
   * Any navigation object that has `goBack()`. Compatible with React Navigation,
   * but the screen does not depend on React Navigation directly — pass any object
   * with that shape, or `{ goBack: () => {} }` if rendered as a standalone modal.
   */
  navigation?: { goBack?: () => void };
}

function tryPrettyJson(raw?: string): string {
  if (!raw || raw.trim() === '') return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/**
 * Wall-clock duration of a request, or null when the log has no usable timings
 * (an in-flight or failed request may carry only a start).
 *
 * Both platforms report epoch milliseconds, but iOS derives them from
 * `timeIntervalSince1970 * 1000` and so sends fractions — hence the rounding.
 * Anything at or above a second reads better in seconds than as four digits
 * of milliseconds.
 */
function formatDuration(log: ApiLog): string | null {
  const { startTime, endTime } = log;
  // Compare against undefined rather than truthiness: a 0 timestamp is falsy.
  if (startTime == null || endTime == null) return null;
  const ms = endTime - startTime;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * Request and response headers in a single block, each under its own sub-label.
 * Sub-labels are only emitted for the sides that actually have headers, so a
 * response-only log doesn't render a dangling "REQUEST" heading.
 */
function buildHeadersSection(log: ApiLog): string {
  const request = headersToText(log.requestHeaders);
  const response = headersToText(log.responseHeaders);
  const blocks: string[] = [];
  if (request) blocks.push(`▸ REQUEST\n${request}`);
  if (response) blocks.push(`▸ RESPONSE\n${response}`);
  return blocks.join('\n\n');
}

/**
 * A request counts as an error when the server rejected it (>= 400) or when it
 * never completed. `parseLog` assigns status -1 to failed/incomplete requests,
 * and those are exactly what someone hunting a bug wants to see.
 */
function isErrorLog(log: ApiLog): boolean {
  return log.status >= 400 || log.status < 0;
}

function matchesQuery(log: ApiLog, needle: string): boolean {
  if (needle === '') return true;
  return log.url.toLowerCase().includes(needle);
}

/** Escape a value for a single-quoted POSIX shell string: ' → '\'' */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ready-to-run curl command replaying the logged request. Uses the RAW request
 * body (not the prettified one) so the replay is byte-identical. Skips the
 * `content-length` header (curl recomputes it) and adds `--compressed` when
 * the request advertised gzip.
 */
function buildCurlCommand(log: ApiLog): string {
  if (!log.url) return '';

  const parts: string[] = [`curl -X ${log.method || 'GET'}`];

  const headers = log.requestHeaders ?? {};
  let wantsCompressed = false;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'content-length') continue;
    if (lower === 'accept-encoding' && value.toLowerCase().includes('gzip')) {
      wantsCompressed = true;
    }
    parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
  }

  if (log.dataSent && log.dataSent !== '') {
    parts.push(`-d ${shellQuote(log.dataSent)}`);
  }
  if (wantsCompressed) {
    parts.push('--compressed');
  }
  parts.push(shellQuote(log.url));

  return parts.join(' \\\n  ');
}

function buildShareText(log: ApiLog): string {
  const duration = formatDuration(log);
  const lines: string[] = [];

  lines.push(`[${log.method}] ${log.url}`);
  lines.push(`Status: ${log.status}${duration ? ` | ${duration}` : ''}`);
  if (log.gqlOperation) lines.push(`GQL Operation: ${log.gqlOperation}`);

  const reqHeaders = headersToText(log.requestHeaders);
  if (reqHeaders) {
    lines.push('\n── REQUEST HEADERS ──────────────');
    lines.push(reqHeaders);
  }

  const reqBody = tryPrettyJson(log.dataSent);
  if (reqBody) {
    lines.push('\n── REQUEST BODY ─────────────────');
    lines.push(reqBody);
  }

  const resHeaders = headersToText(log.responseHeaders);
  if (resHeaders) {
    lines.push('\n── RESPONSE HEADERS ─────────────');
    lines.push(resHeaders);
  }

  const resBody = tryPrettyJson(log.response);
  if (resBody) {
    lines.push('\n── RESPONSE BODY ────────────────');
    lines.push(resBody);
  }

  const curl = buildCurlCommand(log);
  if (curl) {
    lines.push('\n── CURL ─────────────────────────');
    lines.push(curl);
  }

  return lines.join('\n');
}

/** One row of the log list: method, URL, and a right column of status + duration. */
function LogRow({ log, onPress }: { log: ApiLog; onPress: () => void }) {
  const duration = formatDuration(log);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
    >
      <Text style={styles.rowMethod}>{log.method}</Text>
      <Text style={styles.rowUrl}>{log.url}</Text>
      {/* Status and duration share the right column so neither steals width
          from the wrapping URL. */}
      <View style={styles.rowMeta}>
        <Text
          style={[
            styles.rowStatusBadge,
            log.status >= 400 && styles.statusError,
          ]}
        >
          {log.status}
        </Text>
        {duration ? (
          <Text style={styles.rowDuration}>{duration}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const COPIED_FEEDBACK_MS = 1500;

/**
 * One titled block of the detail view with its own Copy and Share actions.
 *
 * The body is `selectable` so any substring can be picked out by hand. Note the
 * actions are buttons rather than a long-press menu: `Text` supports both
 * `selectable` and `onLongPress`, but they compete for the same gesture.
 */
function SectionBlock({ title, content }: { title: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The clipboard gives no visible confirmation on its own, so flash the label.
  const copy = useCallback(() => {
    Clipboard.setString(content);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }, [content]);

  const share = useCallback(() => {
    Share.share({ message: content });
  }, [content]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!content) return null;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.detailSection}>{title}</Text>
        <View style={styles.sectionActions}>
          <Pressable onPress={copy} hitSlop={8} style={styles.sectionAction}>
            <Text
              style={[styles.sectionActionText, copied && styles.sectionCopied]}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </Text>
          </Pressable>
          <Pressable onPress={share} hitSlop={8} style={styles.sectionAction}>
            <Text style={styles.sectionActionText}>Share</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.detailBody} selectable>
        {content}
      </Text>
    </View>
  );
}

export const ApiLoggerScreen: React.FC<ApiLoggerScreenProps> = ({
  navigation,
}) => {
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [selected, setSelected] = useState<ApiLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const goBack = useCallback(() => navigation?.goBack?.(), [navigation]);

  const filtering = query.trim() !== '' || errorsOnly;

  const visibleLogs = useMemo(() => {
    if (!filtering) return logs;
    const needle = query.trim().toLowerCase();
    return logs.filter(
      log => matchesQuery(log, needle) && (!errorsOnly || isErrorLog(log)),
    );
  }, [logs, query, errorsOnly, filtering]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setErrorsOnly(false);
  }, []);

  const loadLogs = useCallback(async () => {
    if (!isLegoApiLoggerAvailable()) {
      setError('LegoAPILoggerModule not available');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const raw = await LegoApiLogger.getLogs();
      // Native getLogs() returns oldest-first; reverse so the newest sits at the
      // top, matching the live-subscribe prepend behaviour below.
      setLogs(raw.map(parseLog).reverse());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load logs';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs();
    if (!isLegoApiLoggerAvailable()) return undefined;
    const unsubscribe = LegoApiLogger.subscribe(log => {
      setLogs(prev => [log, ...prev].slice(0, 500));
    });
    return unsubscribe;
  }, [loadLogs]);

  const clearLogs = useCallback(() => {
    LegoApiLogger.clearLogs();
    setLogs([]);
    setSelected(null);
  }, []);

  const shareLog = useCallback((log: ApiLog) => {
    Share.share({ message: buildShareText(log) });
  }, []);

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <ApiLoggerHeader title="API Logger" onBack={goBack} />
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (selected) {
    const duration = formatDuration(selected);

    return (
      <SafeAreaView style={styles.container}>
        <ApiLoggerHeader
          title={`${selected.method} ${selected.status}`}
          onBack={() => setSelected(null)}
          rightContent={
            <Pressable
              onPress={() => shareLog(selected)}
              style={styles.shareBtn}
            >
              <Text style={styles.shareLabel}>Share</Text>
            </Pressable>
          }
        />

        <ScrollView
          style={styles.detailScroll}
          contentContainerStyle={styles.detailContent}
        >
          <Text style={styles.detailUrl}>{selected.url}</Text>

          <View style={styles.metaRow}>
            <Text
              style={[
                styles.metaBadge,
                selected.status >= 400 && styles.metaBadgeError,
              ]}
            >
              {selected.status}
            </Text>
            {duration && <Text style={styles.metaTime}>{duration}</Text>}
            {selected.gqlOperation ? (
              <Text style={styles.metaGql}>{selected.gqlOperation}</Text>
            ) : null}
          </View>

          <SectionBlock
            title="HEADERS"
            content={buildHeadersSection(selected)}
          />
          <SectionBlock
            title="PAYLOAD"
            content={tryPrettyJson(selected.dataSent)}
          />
          <SectionBlock
            title="RESPONSE BODY"
            content={tryPrettyJson(selected.response)}
          />
          <SectionBlock title="CURL" content={buildCurlCommand(selected)} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ApiLoggerHeader
        title={
          filtering
            ? `API Logger (${visibleLogs.length}/${logs.length})`
            : `API Logger (${logs.length})`
        }
        onBack={goBack}
        rightContent={
          <Pressable onPress={clearLogs} style={styles.shareBtn}>
            <Text style={styles.shareLabel}>Clear</Text>
          </Pressable>
        }
      />

      <View style={styles.filterBar}>
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search URL"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {/* iOS draws its own clear button via `clearButtonMode`; Android has
              no equivalent, so supply one there to avoid a duplicate on iOS. */}
          {Platform.OS !== 'ios' && query !== '' ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={8}
              style={styles.searchClear}
            >
              <Text style={styles.searchClearText}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => setErrorsOnly(prev => !prev)}
          style={[styles.chip, errorsOnly && styles.chipActive]}
        >
          <Text
            style={[styles.chipText, errorsOnly && styles.chipTextActive]}
          >
            Errors
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#42C8B7" />
        </View>
      ) : (
        <FlatList
          data={visibleLogs}
          keyExtractor={item => item.id}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          renderItem={({ item }) => (
            <LogRow log={item} onPress={() => setSelected(item)} />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              {filtering ? (
                <>
                  <Text style={styles.emptyText}>
                    No logs match this filter.
                  </Text>
                  <Pressable onPress={clearFilters} hitSlop={8}>
                    <Text style={styles.emptyAction}>Clear filters</Text>
                  </Pressable>
                </>
              ) : (
                <Text style={styles.emptyText}>
                  No API logs yet. Make some requests.
                </Text>
              )}
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  shareBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  shareLabel: {
    fontSize: 14,
    color: '#42C8B7',
    fontWeight: '600',
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1e293b',
    paddingVertical: 8,
    // Strip Android's default underline padding so the row stays compact.
    paddingHorizontal: 0,
  },
  searchClear: {
    paddingLeft: 6,
  },
  searchClearText: {
    fontSize: 13,
    color: '#94a3b8',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f8fafc',
  },
  chipActive: {
    borderColor: '#dc2626',
    backgroundColor: '#fee2e2',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  chipTextActive: {
    color: '#dc2626',
  },
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    // Top-align so the method + status columns stay put when the URL wraps
    // across multiple lines (the row grows to fit the full URL).
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  rowPressed: {
    backgroundColor: '#f8fafc',
  },
  rowMethod: {
    fontSize: 12,
    fontWeight: '700',
    color: '#42C8B7',
    minWidth: 44,
  },
  rowUrl: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#475569',
  },
  rowMeta: {
    alignItems: 'flex-end',
    minWidth: 52,
  },
  rowStatusBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'right',
  },
  rowDuration: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
    textAlign: 'right',
  },
  statusError: {
    color: '#dc2626',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#dc2626',
  },
  emptyText: {
    fontSize: 14,
    color: '#94a3b8',
  },
  emptyAction: {
    fontSize: 14,
    fontWeight: '600',
    color: '#42C8B7',
    marginTop: 10,
  },
  detailScroll: {
    flex: 1,
  },
  detailContent: {
    padding: 14,
    paddingBottom: 40,
  },
  detailUrl: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  metaBadge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#16a34a',
    backgroundColor: '#dcfce7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  metaBadgeError: {
    color: '#dc2626',
    backgroundColor: '#fee2e2',
  },
  metaTime: {
    fontSize: 12,
    color: '#94a3b8',
  },
  metaGql: {
    fontSize: 11,
    color: '#7c3aed',
    backgroundColor: '#ede9fe',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  section: {
    marginTop: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  detailSection: {
    fontSize: 11,
    fontWeight: '700',
    // Darkened from #94a3b8: the old grey was tuned for a white background and
    // reads as washed out against the tinted bar.
    color: '#475569',
    letterSpacing: 0.8,
  },
  sectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  sectionAction: {
    paddingVertical: 2,
  },
  sectionActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#42C8B7',
  },
  sectionCopied: {
    color: '#16a34a',
  },
  detailBody: {
    fontSize: 11,
    color: '#334155',
    fontFamily: 'monospace',
    lineHeight: 18,
    // Match the heading bar's horizontal padding so text lines up under it.
    paddingHorizontal: 10,
  },
});
