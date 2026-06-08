/**
 * 语义搜索模块（Semantic Search for Knowledge Base）
 * ===================================================
 * 功能：替代原有关键词匹配，用向量余弦相似度做语义搜索。
 * 
 * 工作模式：
 *   Mode A - 预建索引（推荐）：加载 build_knowledge_base.py 生成的索引文件
 *   Mode B - 运行时构建：首次使用时从 IndexedDB 读取数据并向量化（数据量大时不推荐）
 * 
 * 核心 API：
 *   window.semanticSearch(query, topK) → [{text, source, field, score}]
 *   window.semanticSearch.init()        → 初始化并加载索引
 *   window.semanticSearch.isReady()     → 检查是否就绪
 *   window.semanticSearch.buildFromData(data) → 从数据动态构建索引
 * 
 * 依赖：无外部依赖，纯 JS 实现余弦相似度计算
 */

(function() {
    'use strict';

    const SEMANTIC_MODULE = {
        _index: null,       // 预建索引 [{e: [float16...], t: text, s: source, f: field}]
        _ready: false,
        _initPromise: null,

        /**
         * 初始化：优先加载预建索引文件
         */
        init: function() {
            if (this._initPromise) return this._initPromise;
            
            this._initPromise = new Promise(function(resolve) {
                // 检查是否已有索引（页面内二次调用）
                if (window.__SEMANTIC_INDEX__ && window.__SEMANTIC_INDEX__.length > 0) {
                    this._index = window.__SEMANTIC_INDEX__;
                    this._ready = true;
                    console.log('[语义搜索] 索引已就绪: ' + this._index.length + ' 条');
                    resolve(true);
                    return;
                }

                // 等待 index_loader 完成异步加载
                if (window.initSemanticIndex) {
                    window.initSemanticIndex().then(function() {
                        if (window.__SEMANTIC_INDEX__ && window.__SEMANTIC_INDEX__.length > 0) {
                            this._index = window.__SEMANTIC_INDEX__;
                            this._ready = true;
                            console.log('[语义搜索] 索引加载完成: ' + this._index.length + ' 条');
                            resolve(true);
                        } else {
                            console.warn('[语义搜索] 索引为空，语义搜索降级为关键词');
                            this._ready = false;
                            resolve(false);
                        }
                    }.bind(this)).catch(function(e) {
                        console.warn('[语义搜索] 加载失败，降级为关键词匹配:', e);
                        this._ready = false;
                        resolve(false);
                    }.bind(this));
                } else {
                    console.warn('[语义搜索] index_loader 未找到，语义搜索不可用');
                    this._ready = false;
                    resolve(false);
                }
            }.bind(this));

            return this._initPromise;
        },

        /**
         * 检查是否就绪
         */
        isReady: function() {
            return this._ready && this._index && this._index.length > 0;
        },

        /**
         * 语义搜索主函数
         * @param {number[]} queryEmbedding - 查询向量（float32 数组）
         * @param {number} topK - 返回条数
         * @param {Object} options - 可选配置
         * @param {string} options.filterSource - 按来源过滤（如 "规章制度"）
         * @param {number} options.minScore - 最低相似度阈值（默认 0.0）
         * @returns {Array<{text, source, field, score, recordId}>}
         */
        search: function(queryEmbedding, topK, options) {
            if (!this.isReady()) {
                console.warn('[语义搜索] 索引未就绪');
                return [];
            }

            topK = topK || 5;
            options = options || {};
            const minScore = options.minScore || 0;
            const filterSource = options.filterSource || null;

            const t0 = performance.now();
            const results = [];

            // 如果 queryEmbedding 是 float16，先转 float32
            const qVec = queryEmbedding;

            for (let i = 0; i < this._index.length; i++) {
                const item = this._index[i];
                
                // 来源过滤
                if (filterSource && item.s && !item.s.includes(filterSource)) {
                    continue;
                }

                const score = this._cosineSim(qVec, item.e);
                
                // 用堆维护 topK（避免全排序）
                if (score >= minScore) {
                    if (results.length < topK * 3) {
                        results.push({ idx: i, score: score });
                    } else {
                        // 找到最小值替换
                        let minIdx = 0;
                        for (let j = 1; j < results.length; j++) {
                            if (results[j].score < results[minIdx].score) minIdx = j;
                        }
                        if (score > results[minIdx].score) {
                            results[minIdx] = { idx: i, score: score };
                        }
                    }
                }
            }

            // 排序 + TopK
            results.sort((a, b) => b.score - a.score);
            const top = results.slice(0, topK);

            // 去重：同来源+同字段只保留最高分
            const seen = new Set();
            const deduped = [];
            for (const r of top) {
                const item = this._index[r.idx];
                const key = (item.s || '') + '|' + (item.t || '').slice(0, 60);
                if (seen.has(key)) continue;
                seen.add(key);
                deduped.push(r);
                if (deduped.length >= topK) break;
            }

            const elapsed = performance.now() - t0;
            if (deduped.length > 0) {
                console.log('[语义搜索] ' + elapsed.toFixed(1) + 'ms, 返回 ' + deduped.length + ' 条, '
                    + '最高分 ' + deduped[0].score.toFixed(3));
            }

            return deduped.map(r => {
                const item = this._index[r.idx];
                return {
                    text: item.t,
                    source: item.s || '未知来源',
                    field: item.f || '',
                    score: r.score,
                    recordId: item.r
                };
            });
        },

        /**
         * 获取查询向量（通过 DeepSeek Embedding API）
         * @param {string} text - 查询文本
         * @param {string} apiKey - API Key
         * @returns {Promise<number[]>}
         */
        getQueryEmbedding: async function(text, apiKey) {
            // 使用 DeepSeek embedding endpoint（如果可用）
            // 回退：使用简单的词频向量（不推荐，但保证可用）
            try {
                const resp = await fetch('https://api.deepseek.com/v1/embeddings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + apiKey
                    },
                    body: JSON.stringify({
                        model: 'deepseek-chat',
                        input: text
                    })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.data && data.data[0]) {
                        return data.data[0].embedding;
                    }
                }
            } catch(e) {
                console.warn('[语义搜索] Embedding API 不可用，使用回退方法');
            }
            
            // 回退：简单词袋向量（效果差但不会崩溃）
            return this._fallbackEmbed(text);
        },

        /**
         * 回退向量化：简单词频（效果有限，用于 API 不可用时）
         */
        _fallbackEmbed: function(text) {
            // 取第一条索引的向量维度
            const dim = (this._index && this._index[0] && this._index[0].e) 
                ? this._index[0].e.length 
                : 384;
            
            const vec = new Array(dim).fill(0);
            const chars = text.replace(/\s/g, '');
            
            for (let i = 0; i < chars.length; i++) {
                const code = chars.charCodeAt(i);
                vec[code % dim] += 1;
            }
            
            // 归一化
            let norm = 0;
            for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
            norm = Math.sqrt(norm) || 1;
            for (let i = 0; i < dim; i++) vec[i] /= norm;
            
            return vec;
        },

        /**
         * 余弦相似度（支持 float16 + float32 混合计算）
         */
        _cosineSim: function(a, b) {
            let dot = 0, na = 0, nb = 0;
            const len = Math.min(a.length, b.length);
            for (let i = 0; i < len; i++) {
                dot += a[i] * b[i];
                na += a[i] * a[i];
                nb += b[i] * b[i];
            }
            return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
        },

        /**
         * 运行时从数据构建索引（Mode B - 用于没有预建索引时）
         * 注意：数据量大时此方法很慢，建议使用预建索引
         */
        buildFromData: async function(dataItems, getTextFn) {
            if (!window.transformers) {
                console.warn('[语义搜索] Transformers.js 未加载，无法运行时构建索引');
                return false;
            }

            console.log('[语义搜索] 运行时构建索引...');
            const chunks = [];
            
            for (let i = 0; i < dataItems.length; i++) {
                const text = getTextFn(dataItems[i], i);
                if (!text || text.length < 5) continue;
                
                // 简单切片
                const sentences = text.split(/(?<=[。！？；\n])/);
                let current = '';
                for (const s of sentences) {
                    if (current.length + s.length > 500 && current) {
                        chunks.push({ t: current.trim(), s: '运行时数据', f: '', r: i });
                        current = s;
                    } else {
                        current += s;
                    }
                }
                if (current.trim()) {
                    chunks.push({ t: current.trim(), s: '运行时数据', f: '', r: i });
                }
            }

            if (chunks.length === 0) return false;

            try {
                const { pipeline } = window.transformers;
                const extractor = await pipeline('feature-extraction', 
                    'Xenova/all-MiniLM-L6-v2', 
                    { quantized: true }
                );

                for (const chunk of chunks) {
                    const emb = await extractor(chunk.t, { pooling: 'mean', normalize: true });
                    chunk.e = Array.from(emb.data);
                }

                this._index = chunks;
                this._ready = true;
                console.log('[语义搜索] 运行时索引完成: ' + chunks.length + ' 条');
                return true;
            } catch(e) {
                console.error('[语义搜索] 运行时索引失败:', e);
                return false;
            }
        }
    };

    // 暴露到全局
    window.semanticSearch = {
        init: function() { return SEMANTIC_MODULE.init(); },
        isReady: function() { return SEMANTIC_MODULE.isReady(); },
        search: function(qEmb, topK, opts) { return SEMANTIC_MODULE.search(qEmb, topK, opts); },
        getQueryEmbedding: function(text, key) { return SEMANTIC_MODULE.getQueryEmbedding(text, key); },
        buildFromData: function(data, fn) { return SEMANTIC_MODULE.buildFromData(data, fn); },
        _fallbackEmbed: function(text) { return SEMANTIC_MODULE._fallbackEmbed(text); }
    };

    // 页面加载后自动初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            SEMANTIC_MODULE.init();
        });
    } else {
        SEMANTIC_MODULE.init();
    }

})();
