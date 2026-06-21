/**
 * 安监智能辅助系统 - 搜索 Worker
 * 在后台线程运行 Fuse.js 搜索，避免阻塞主线程 UI
 */
importScripts('https://cdnjs.cloudflare.com/ajax/libs/fuse.js/6.6.2/fuse.min.js');

var fuseInstance = null;
var data = [];
var _keys = [
    { name: '性质', weight: 0.3 },
    { name: 'category', weight: 0.2 },
    { name: 'content', weight: 0.3 },
    { name: 'regulation', weight: 0.1 },
    { name: 'unit', weight: 0.1 }
];

self.addEventListener('message', function(e) {
    var msg = e.data;
    switch (msg.type) {
        case 'init':
            data = msg.payload;
            try {
                fuseInstance = new Fuse(data, {
                    keys: _keys,
                    threshold: 0.35,
                    includeScore: true,
                    minMatchCharLength: 1,
                    useExtendedSearch: true,
                    ignoreLocation: true,
                    findAllMatches: true
                });
            } catch(err) {
                self.postMessage({ type: 'error', error: err.message });
                return;
            }
            self.postMessage({ type: 'ready', count: data.length });
            break;

        case 'search':
            if (!fuseInstance) {
                self.postMessage({ type: 'error', error: 'Worker 未初始化，请先发送 init' });
                return;
            }
            var keywords = msg.keywords || [];
            var results = [];
            if (keywords.length === 0) {
                results = data;
            } else {
                var resultMap = {};
                keywords.forEach(function(kw) {
                    var hits = fuseInstance.search(kw.trim());
                    hits.forEach(function(hit) {
                        var idx = data.indexOf(hit.item);
                        if (idx === -1) return;
                        if (!resultMap[idx]) {
                            resultMap[idx] = { item: hit.item, matchCount: 0, maxScore: 0 };
                        }
                        resultMap[idx].matchCount++;
                        var score = Math.round((1 - (hit.score || 0)) * 100);
                        if (score > resultMap[idx].maxScore) resultMap[idx].maxScore = score;
                    });
                });
                Object.keys(resultMap).forEach(function(idx) {
                    var entry = resultMap[idx];
                    results.push({
                        item: entry.item,
                        matchCount: entry.matchCount,
                        totalKw: keywords.length,
                        matchRate: Math.round((entry.matchCount / keywords.length) * 100),
                        fuseScore: entry.maxScore
                    });
                });
                results.sort(function(a, b) {
                    if (b.matchRate !== a.matchRate) return b.matchRate - a.matchRate;
                    if (b.fuseScore !== a.fuseScore) return b.fuseScore - a.fuseScore;
                    return new Date(b.item.datetime || 0) - new Date(a.item.datetime || 0);
                });
            }
            self.postMessage({ type: 'result', data: results, total: data.length });
            break;

        case 'update':
            // 增量更新数据
            if (msg.payload && msg.payload.length > 0) {
                data = msg.payload;
                try {
                    fuseInstance = new Fuse(data, {
                        keys: _keys,
                        threshold: 0.35,
                        includeScore: true,
                        minMatchCharLength: 1,
                        useExtendedSearch: true,
                        ignoreLocation: true,
                        findAllMatches: true
                    });
                } catch(err) {
                    self.postMessage({ type: 'error', error: err.message });
                }
            }
            break;
    }
});
