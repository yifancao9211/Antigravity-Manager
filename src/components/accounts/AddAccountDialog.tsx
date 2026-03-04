import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Database, Globe, FileClock, Loader2, CheckCircle2, XCircle, Copy, Check, Info, Link2 } from 'lucide-react';
import { useAccountStore } from '../../stores/useAccountStore';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { request as invoke } from '../../utils/request';
import { isTauri } from '../../utils/env';
import { copyToClipboard } from '../../utils/clipboard';

interface AddAccountDialogProps {
    onAdd: (email: string, refreshToken: string) => Promise<void>;
    showText?: boolean;
}

type Status = 'idle' | 'loading' | 'success' | 'error';

function AddAccountDialog({ onAdd, showText = true }: AddAccountDialogProps) {
    const { t } = useTranslation();
    const fetchAccounts = useAccountStore(state => state.fetchAccounts);
    const [isOpen, setIsOpen] = useState(false);
    const [selectedProvider, setSelectedProvider] = useState<'google' | 'codex'>('google');
    const [activeTab, setActiveTab] = useState<'oauth' | 'token' | 'import'>(isTauri() ? 'oauth' : 'token');
    const [codexActiveTab, setCodexActiveTab] = useState<'oauth' | 'token' | 'import'>('oauth');
    const [refreshToken, setRefreshToken] = useState('');
    const [oauthUrl, setOauthUrl] = useState('');
    const [oauthUrlCopied, setOauthUrlCopied] = useState(false);
    const [manualCode, setManualCode] = useState('');
    const [codexToken, setCodexToken] = useState('');
    const [codexRefreshToken, setCodexRefreshToken] = useState('');

    // UI State
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState('');

    const { startOAuthLogin, completeOAuthLogin, cancelOAuthLogin, importFromDb, importV1Accounts, importFromCustomDb, addCodexAccountManual, importCodexFromFile, startCodexOAuthLogin } = useAccountStore();

    const oauthUrlRef = useRef(oauthUrl);
    const statusRef = useRef(status);
    const activeTabRef = useRef(activeTab);
    const isOpenRef = useRef(isOpen);

    useEffect(() => {
        oauthUrlRef.current = oauthUrl;
        statusRef.current = status;
        activeTabRef.current = activeTab;
        isOpenRef.current = isOpen;
    }, [oauthUrl, status, activeTab, isOpen]);

    // Reset state when dialog opens or tab changes
    useEffect(() => {
        if (isOpen) {
            resetState();
        }
    }, [isOpen, activeTab]);

    // Listen for OAuth URL
    useEffect(() => {
        if (!isTauri()) return;
        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            unlisten = await listen('oauth-url-generated', (event) => {
                setOauthUrl(event.payload as string);
                // 自动复制到剪贴板? 可选，这里只设置状态让用户手动复制
            });
        };

        setupListener();

        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    // Listen for OAuth callback completion (user may open the URL manually without clicking Start)
    useEffect(() => {
        if (!isTauri()) return;
        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            unlisten = await listen('oauth-callback-received', async () => {
                if (!isOpenRef.current) return;
                if (activeTabRef.current !== 'oauth') return;
                if (statusRef.current === 'loading' || statusRef.current === 'success') return;
                if (!oauthUrlRef.current) return;

                // Auto-complete: exchange code and save account (no browser open)
                setStatus('loading');
                setMessage(`${t('accounts.add.tabs.oauth')}...`);

                try {
                    await completeOAuthLogin();
                    setStatus('success');
                    setMessage(`${t('accounts.add.tabs.oauth')} ${t('common.success')}!`);
                    setTimeout(() => {
                        setIsOpen(false);
                        resetState();
                    }, 1500);
                } catch (error) {
                    setStatus('error');
                    let errorMsg = String(error);
                    if (errorMsg.includes('Refresh Token') || errorMsg.includes('refresh_token')) {
                        setMessage(errorMsg);
                    } else if (errorMsg.includes('Tauri') || errorMsg.toLowerCase().includes('environment') || errorMsg.includes('环境')) {
                        setMessage(t('common.environment_error', { error: errorMsg }));
                    } else {
                        setMessage(`${t('accounts.add.tabs.oauth')} ${t('common.error')}: ${errorMsg}`);
                    }
                }
            });
        };

        setupListener();

        return () => {
            if (unlisten) unlisten();
        };
    }, [completeOAuthLogin, t]);

    // Pre-generate OAuth URL when dialog opens on OAuth tab (so URL is shown BEFORE "Start OAuth")
    useEffect(() => {
        if (!isOpen) return;
        if (activeTab !== 'oauth') return;
        if (oauthUrl) return;

        invoke<any>('prepare_oauth_url')
            .then((res) => {
                const url = typeof res === 'string' ? res : res?.url;
                if (url && url.length > 0) setOauthUrl(url);
            })
            .catch((e) => {
                console.error('Failed to prepare OAuth URL:', e);
            });
    }, [isOpen, activeTab, oauthUrl]);

    // If user navigates away from OAuth tab, cancel prepared flow to release the port.
    useEffect(() => {
        if (!isOpen) return;
        if (activeTab === 'oauth') return;
        if (!oauthUrl) return;

        cancelOAuthLogin().catch(() => { });
        setOauthUrl('');
        setOauthUrlCopied(false);
    }, [isOpen, activeTab]);

    const resetState = () => {
        setStatus('idle');
        setMessage('');
        setRefreshToken('');
        setOauthUrl('');
        setOauthUrlCopied(false);
        setCodexToken('');
        setCodexRefreshToken('');
    };

    const handleAction = async (
        actionName: string,
        actionFn: () => Promise<any>,
        options?: { clearOauthUrl?: boolean }
    ) => {
        setStatus('loading');
        setMessage(`${actionName}...`);
        if (options?.clearOauthUrl !== false) {
            setOauthUrl(''); // Clear previous URL
        }
        try {
            await actionFn();
            setStatus('success');
            setMessage(`${actionName} ${t('common.success')}!`);

            // 延迟关闭,让用户看到成功状态
            setTimeout(() => {
                setIsOpen(false);
                resetState();
            }, 1500);
        } catch (error) {
            setStatus('error');

            // 改进错误信息显示
            let errorMsg = String(error);

            // 如果是 refresh_token 缺失错误,显示完整信息(包含解决方案)
            if (errorMsg.includes('Refresh Token') || errorMsg.includes('refresh_token')) {
                setMessage(errorMsg);
            } else if (errorMsg.includes('Tauri') || errorMsg.toLowerCase().includes('environment') || errorMsg.includes('环境')) {
                // 环境错误
                setMessage(t('common.environment_error', { error: errorMsg }));
            } else {
                // 其他错误
                setMessage(`${actionName} ${t('common.error')}: ${errorMsg}`);
            }
        }
    };

    const handleSubmit = async () => {
        if (!refreshToken) {
            setStatus('error');
            setMessage(t('accounts.add.token.error_token'));
            return;
        }

        setStatus('loading');

        // 1. 尝试解析输入
        let tokens: string[] = [];
        const input = refreshToken.trim();

        try {
            // 尝试解析为 JSON
            if (input.startsWith('[') && input.endsWith(']')) {
                const parsed = JSON.parse(input);
                if (Array.isArray(parsed)) {
                    tokens = parsed
                        .map((item: any) => item.refresh_token)
                        .filter((t: any) => typeof t === 'string' && t.startsWith('1//'));
                }
            }
        } catch (e) {
            // JSON 解析失败,忽略
            console.debug('JSON parse failed, falling back to regex', e);
        }

        // 2. 如果 JSON 解析没有结果,尝试正则提取 (或者输入不是 JSON)
        if (tokens.length === 0) {
            const regex = /1\/\/[a-zA-Z0-9_\-]+/g;
            const matches = input.match(regex);
            if (matches) {
                tokens = matches;
            }
        }

        // 去重
        tokens = [...new Set(tokens)];

        if (tokens.length === 0) {
            setStatus('error');
            setMessage(t('accounts.add.token.error_token')); // 或者提示"未找到有效 Token"
            return;
        }

        // 3. 批量添加
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < tokens.length; i++) {
            const currentToken = tokens[i];
            setMessage(t('accounts.add.token.batch_progress', { current: i + 1, total: tokens.length }));

            try {
                await onAdd("", currentToken);
                successCount++;
            } catch (error) {
                console.error(`Failed to add token ${i + 1}:`, error);
                failCount++;
            }
            // 稍微延迟一下,避免太快
            await new Promise(r => setTimeout(r, 100));
        }

        // 4. 结果反馈
        if (successCount === tokens.length) {
            setStatus('success');
            setMessage(t('accounts.add.token.batch_success', { count: successCount }));
            setTimeout(() => {
                setIsOpen(false);
                resetState();
            }, 1500);
        } else if (successCount > 0) {
            // 部分成功
            setStatus('success'); // 还是用绿色,但提示部分失败
            setMessage(t('accounts.add.token.batch_partial', { success: successCount, fail: failCount }));
            // 不自动关闭,让用户看到结果
        } else {
            // 全部失败
            setStatus('error');
            setMessage(t('accounts.add.token.batch_fail'));
        }
    };

    const handleOAuthWeb = async () => {
        try {
            setStatus('loading');
            setMessage(t('accounts.add.oauth.btn_start') + '...');

            // 1. 获取 URL (指向 /auth/callback)
            const res = await invoke<any>('prepare_oauth_url');
            const url = typeof res === 'string' ? res : res.url;

            if (!url) {
                throw new Error(t('accounts.add.oauth.error_no_url', 'OAuth URLを取得できませんでした'));
            }

            setOauthUrl(url); // 确保链接在 UI 中可见，方便用户手动复制

            // 2. 打开新标签页 (响应用户反馈：Web 端直接使用新标签体验更好)
            const popup = window.open(url, '_blank');

            if (!popup) {
                setStatus('error');
                setMessage(t('accounts.add.oauth.popup_blocked', 'ポップアップがブロックされました'));
                return;
            }

            // 3. 监听消息
            const handleMessage = async (event: MessageEvent) => {
                // 安全检查: 如果定义了 ORIGIN 校验更好，这里暂时检查 data type
                if (event.data?.type === 'oauth-success') {
                    popup.close();
                    window.removeEventListener('message', handleMessage);

                    // 4. 成功后刷新列表
                    await fetchAccounts();

                    setStatus('success');
                    setMessage(t('accounts.add.oauth_success') || t('common.success'));

                    setTimeout(() => {
                        setIsOpen(false);
                        resetState();
                    }, 1500);
                }
            };

            window.addEventListener('message', handleMessage);

            // 5. 检测窗口关闭 (用户手动关闭)
            const timer = setInterval(() => {
                if (popup.closed) {
                    clearInterval(timer);
                    window.removeEventListener('message', handleMessage);
                    if (statusRef.current === 'loading') { // 如果还在 loading 状态就关闭了，说明取消了
                        setStatus('idle');
                        setMessage('');
                    }
                }
            }, 1000);

        } catch (error) {
            console.error('OAuth Web Error:', error);
            setStatus('error');
            setMessage(`${t('common.error')}: ${error}`);
        }
    };

    const handleOAuth = () => {
        if (!isTauri()) {
            handleOAuthWeb();
            return;
        }
        // Default flow: opens the default browser and completes automatically.
        // (If user opened the URL manually, completion is also triggered by oauth-callback-received.)
        handleAction(t('accounts.add.tabs.oauth'), startOAuthLogin, { clearOauthUrl: false });
    };

    const handleCompleteOAuth = () => {
        // Manual flow: user already authorized in their preferred browser, just finish the flow.
        handleAction(t('accounts.add.tabs.oauth'), completeOAuthLogin, { clearOauthUrl: false });
    };

    const handleCopyUrl = async () => {
        if (oauthUrl) {
            const success = await copyToClipboard(oauthUrl);
            if (success) {
                setOauthUrlCopied(true);
                window.setTimeout(() => setOauthUrlCopied(false), 1500);
            }
        }
    };

    const handleManualSubmit = async () => {
        if (!manualCode.trim()) return;

        setStatus('loading');
        setMessage(t('accounts.add.oauth.manual_submitting', '認可コードを送信中...'));

        try {
            await invoke('submit_oauth_code', { code: manualCode.trim(), state: null });

            // 提交成功反馈
            setStatus('success');
            setMessage(t('accounts.add.oauth.manual_submitted', '認可コードを送信しました。バックエンドで処理中です...'));

            setManualCode('');

            // 对齐 Web 模式下的刷新逻辑
            if (!isTauri()) {
                setTimeout(async () => {
                    await fetchAccounts();
                    setIsOpen(false);
                    resetState();
                }, 2000);
            }
        } catch (error) {
            let errStr = String(error);
            if (errStr.includes("No active OAuth flow")) {
                setMessage(t('accounts.add.oauth.error_no_flow'));
                setStatus('error');
            } else {
                setMessage(`${t('common.error')}: ${errStr}`);
                setStatus('error');
            }
        }
    };

    const handleImportDb = () => {
        handleAction(t('accounts.add.tabs.import'), importFromDb);
    };

    const handleImportV1 = () => {
        handleAction(t('accounts.add.import.btn_v1'), importV1Accounts);
    };

    const handleImportCustomDb = async () => {
        try {
            if (!isTauri()) {
                alert(t('common.tauri_api_not_loaded') || 'Storage import only works in desktop app.');
                return;
            }
            const selected = await open({
                multiple: false,
                filters: [{
                    name: 'VSCode DB',
                    extensions: ['vscdb']
                }, {
                    name: 'All Files',
                    extensions: ['*']
                }]
            });

            if (selected && typeof selected === 'string') {
                handleAction(t('accounts.add.import.btn_custom_db') || 'Import Custom DB', () => importFromCustomDb(selected));
            }
        } catch (err) {
            console.error('Failed to open dialog:', err);
        }
    };

    const handleCodexOAuth = () => {
        handleAction(t('accounts.add.codex_oauth'), startCodexOAuthLogin);
    };

    const handleCodexTokenSubmit = async () => {
        if (!codexToken.trim()) {
            setStatus('error');
            setMessage(t('accounts.add.token.error_token'));
            return;
        }
        await handleAction(t('accounts.add.codex_token'), () =>
            addCodexAccountManual(codexToken.trim(), codexRefreshToken.trim() || undefined)
        );
    };

    const handleCodexImport = () => {
        handleAction(t('accounts.add.codex_import'), importCodexFromFile);
    };

    const handleCodexBatchImport = async () => {
        try {
            const selectedFiles = await open({
                multiple: true,
                filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (!selectedFiles || (Array.isArray(selectedFiles) && selectedFiles.length === 0)) return;

            const files = Array.isArray(selectedFiles) ? selectedFiles : [selectedFiles];

            setStatus('loading');
            setMessage(t('accounts.add.codex_batch_import'));

            const result = await invoke('import_codex_from_files', { files }) as { success: number; failed: number; errors: string[] };

            if (result.success > 0) {
                await fetchAccounts();
            }

            if (result.failed === 0 && result.success > 0) {
                setStatus('success');
                setMessage(t('accounts.add.codex_batch_import_success', { count: result.success }));
            } else if (result.success > 0 && result.failed > 0) {
                setStatus('success');
                setMessage(t('accounts.add.codex_batch_import_partial', { success: result.success, failed: result.failed }));
            } else if (result.success === 0 && result.failed > 0) {
                setStatus('error');
                setMessage(t('accounts.add.codex_batch_import_failed', { count: result.failed }));
            } else {
                setStatus('error');
                setMessage(t('accounts.add.codex_batch_import_empty'));
            }
        } catch (error) {
            setStatus('error');
            setMessage(String(error));
        }
    };

    // 状态提示组件
    const StatusAlert = () => {
        if (status === 'idle' || !message) return null;

        const styles = {
            loading: 'alert-info',
            success: 'alert-success',
            error: 'alert-error'
        };

        const icons = {
            loading: <Loader2 className="w-5 h-5 animate-spin" />,
            success: <CheckCircle2 className="w-5 h-5" />,
            error: <XCircle className="w-5 h-5" />
        };

        return (
            <div className={`alert ${styles[status]} mb-4 text-sm py-2 shadow-sm`}>
                {icons[status]}
                <span>{message}</span>
            </div>
        );
    };

    return (
        <>
            <button
                className="px-2.5 lg:px-4 py-2 bg-white dark:bg-base-100 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-base-200 transition-colors flex items-center gap-2 shadow-sm border border-gray-200/50 dark:border-base-300 relative z-[100]"
                onClick={() => {
                    console.log('AddAccountDialog button clicked');
                    setIsOpen(true);
                }}
                title={!showText ? t('accounts.add_account') : undefined}
            >
                <Plus className="w-4 h-4" />
                {showText && <span className="hidden lg:inline">{t('accounts.add_account')}</span>}
            </button>

            {isOpen && createPortal(
                <div
                    className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
                    style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
                >
                    {/* Draggable Top Region */}
                    <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-[1]" />

                    {/* Click outside to close */}
                    <div className="absolute inset-0 z-[0]" onClick={() => setIsOpen(false)} />

                    <div className="bg-white dark:bg-base-100 text-gray-900 dark:text-base-content rounded-2xl shadow-2xl w-full max-w-lg p-6 relative z-[10] m-4 max-h-[90vh] overflow-y-auto">
                        <h3 className="font-bold text-lg mb-4">{t('accounts.add.title')}</h3>

                        {/* Provider selection */}
                        <div className="flex gap-2 mb-4">
                            <button
                                className={`flex-1 p-3 rounded-lg border-2 transition-all text-left ${selectedProvider === 'google' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'}`}
                                onClick={() => setSelectedProvider('google')}
                            >
                                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">{t('accounts.add.provider_google')}</div>
                                <div className="text-xs text-gray-500">Google / Gemini / Claude</div>
                            </button>
                            <button
                                className={`flex-1 p-3 rounded-lg border-2 transition-all text-left ${selectedProvider === 'codex' ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : 'border-gray-200 dark:border-gray-700'}`}
                                onClick={() => setSelectedProvider('codex')}
                            >
                                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">{t('accounts.add.provider_codex')}</div>
                                <div className="text-xs text-gray-500">OpenAI / GPT / O-series</div>
                            </button>
                        </div>

                        {/* Tab 导航 - 胶囊风格 */}
                        {selectedProvider === 'google' && (
                            <div className="bg-gray-100 dark:bg-base-200 p-1 rounded-xl mb-6 grid grid-cols-3 gap-1">
                                <button
                                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'oauth'
                                        ? 'bg-white dark:bg-base-100 shadow-sm text-blue-600 dark:text-blue-400'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-base-300'
                                        } `}
                                    onClick={() => setActiveTab('oauth')}
                                >
                                    {t('accounts.add.tabs.oauth')}
                                </button>
                                <button
                                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'token'
                                        ? 'bg-white dark:bg-base-100 shadow-sm text-blue-600 dark:text-blue-400'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-base-300'
                                        } `}
                                    onClick={() => setActiveTab('token')}
                                >
                                    {t('accounts.add.tabs.token')}
                                </button>
                                <button
                                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'import'
                                        ? 'bg-white dark:bg-base-100 shadow-sm text-blue-600 dark:text-blue-400'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-base-300'
                                        } `}
                                    onClick={() => setActiveTab('import')}
                                >
                                    {t('accounts.add.tabs.import')}
                                </button>
                            </div>
                        )}

                        {selectedProvider === 'codex' && (
                            <div className="bg-gray-100 dark:bg-base-200 p-1 rounded-xl mb-6 grid grid-cols-3 gap-1">
                                <button
                                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${codexActiveTab === 'oauth'
                                        ? 'bg-white dark:bg-base-100 shadow-sm text-green-600 dark:text-green-400'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-base-300'
                                        } `}
                                    onClick={() => setCodexActiveTab('oauth')}
                                >
                                    {t('accounts.add.codex_oauth')}
                                </button>
                                <button
                                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${codexActiveTab === 'token'
                                        ? 'bg-white dark:bg-base-100 shadow-sm text-green-600 dark:text-green-400'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-base-300'
                                        } `}
                                    onClick={() => setCodexActiveTab('token')}
                                >
                                    {t('accounts.add.codex_token')}
                                </button>
                                <button
                                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${codexActiveTab === 'import'
                                        ? 'bg-white dark:bg-base-100 shadow-sm text-green-600 dark:text-green-400'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-base-300'
                                        } `}
                                    onClick={() => setCodexActiveTab('import')}
                                >
                                    {t('accounts.add.codex_import')}
                                </button>
                            </div>
                        )}

                        {/* 添加 Web 模式提示 */}
                        {!isTauri() && selectedProvider === 'google' && (
                            <div className="alert alert-info mb-4 text-xs py-2 flex items-center gap-2 bg-blue-50 dark:bg-blue-900/10 text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-800">
                                <Info className="w-4 h-4" />
                                <span>{t('accounts.add.oauth.web_hint', '将在新窗口中打开 Google 登录页')}</span>
                            </div>
                        )}

                        {/* 状态提示区 */}
                        <StatusAlert />

                        <div className="min-h-[200px]">
                            {selectedProvider === 'google' && (
                                <>
                                    {/* OAuth 授权 */}
                                    {activeTab === 'oauth' && (
                                        <div className="space-y-6 py-4">
                                            <div className="text-center space-y-3">
                                                <div className="bg-blue-50 dark:bg-blue-900/20 p-6 rounded-full w-20 h-20 mx-auto flex items-center justify-center">
                                                    <Globe className="w-10 h-10 text-blue-500" />
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-medium text-gray-900 dark:text-gray-100">{t('accounts.add.oauth.recommend')}</h4>
                                                    <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">
                                                        {t('accounts.add.oauth.desc')}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="space-y-3">
                                                <button
                                                    className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl shadow-lg shadow-blue-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                                                    onClick={handleOAuth}
                                                    disabled={status === 'loading' || status === 'success'}
                                                >
                                                    {status === 'loading' ? t('accounts.add.oauth.btn_waiting') : t('accounts.add.oauth.btn_start')}
                                                </button>

                                                {oauthUrl && (
                                                    <div className="space-y-2">
                                                        <div className="text-[11px] text-gray-500 dark:text-gray-400 text-left">
                                                            {t('accounts.add.oauth.link_label')}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            className="w-full px-4 py-2 bg-white dark:bg-base-100 text-gray-600 dark:text-gray-300 text-sm font-medium rounded-xl border border-dashed border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-base-200 transition-all flex items-center gap-2"
                                                            onClick={handleCopyUrl}
                                                            title={t('accounts.add.oauth.link_click_to_copy')}
                                                        >
                                                            {oauthUrlCopied ? (
                                                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                                                            ) : (
                                                                <Copy className="w-3.5 h-3.5" />
                                                            )}
                                                            <code className="text-[11px] font-mono truncate flex-1 text-left">
                                                                {oauthUrl}
                                                            </code>
                                                            <span className="text-[11px] whitespace-nowrap">
                                                                {oauthUrlCopied ? t('accounts.add.oauth.copied') : t('accounts.add.oauth.copy_link')}
                                                            </span>
                                                        </button>

                                                        <button
                                                            type="button"
                                                            className="w-full px-4 py-2 bg-white dark:bg-base-100 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-xl border border-gray-200 dark:border-base-300 hover:bg-gray-50 dark:hover:bg-base-200 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                                                            onClick={handleCompleteOAuth}
                                                            disabled={status === 'loading' || status === 'success'}
                                                        >
                                                            <CheckCircle2 className="w-4 h-4" />
                                                            {t('accounts.add.oauth.btn_finish')}
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Manual Code Entry - Always enabled to rescue stuck flows */}
                                                <div className="pt-4 mt-2 border-t border-gray-100 dark:border-base-200">
                                                    <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500 mb-2 uppercase tracking-wider">
                                                        {t('accounts.add.oauth.manual_hint')}
                                                    </div>
                                                    <div className="relative group/manual flex gap-2">
                                                        <div className="relative flex-1">
                                                            <input
                                                                type="text"
                                                                className="w-full text-xs py-2 px-3 bg-white dark:bg-base-100 border border-gray-200 dark:border-base-300 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all placeholder:text-gray-300 dark:placeholder:text-gray-600"
                                                                placeholder={t('accounts.add.oauth.manual_placeholder')}
                                                                value={manualCode}
                                                                onChange={(e) => setManualCode(e.target.value)}
                                                            />
                                                        </div>
                                                        <button
                                                            className="px-4 py-2 bg-neutral text-white dark:bg-white dark:text-neutral text-xs font-semibold rounded-xl hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 disabled:scale-100 flex items-center gap-1.5"
                                                            onClick={handleManualSubmit}
                                                            disabled={!manualCode.trim()}
                                                        >
                                                            <Link2 className="w-3.5 h-3.5" />
                                                            {t('common.submit')}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Refresh Token */}
                                    {activeTab === 'token' && (
                                        <div className="space-y-4 py-2">
                                            <div className="bg-gray-50 dark:bg-base-200 p-4 rounded-lg border border-gray-200 dark:border-base-300">
                                                <div className="flex justify-between items-center mb-2">
                                                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('accounts.add.token.label')}</span>
                                                </div>
                                                <textarea
                                                    className="textarea textarea-bordered w-full h-32 font-mono text-xs leading-relaxed focus:outline-none focus:border-blue-500 transition-colors bg-white dark:bg-base-100 text-gray-900 dark:text-base-content border-gray-300 dark:border-base-300 placeholder:text-gray-400"
                                                    placeholder={t('accounts.add.token.placeholder')}
                                                    value={refreshToken}
                                                    onChange={(e) => setRefreshToken(e.target.value)}
                                                    disabled={status === 'loading' || status === 'success'}
                                                />
                                                <p className="text-[10px] text-gray-400 mt-2">
                                                    {t('accounts.add.token.hint')}
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {/* 从数据库导入 */}
                                    {activeTab === 'import' && (
                                        <div className="space-y-6 py-2">
                                            <div className="space-y-2">
                                                <h4 className="font-semibold flex items-center gap-2 text-gray-800 dark:text-gray-200">
                                                    <Database className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                                                    {t('accounts.add.import.scheme_a')}
                                                </h4>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                                    {t('accounts.add.import.scheme_a_desc')}
                                                </p>
                                                <button
                                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-base-200 text-gray-700 dark:text-gray-300 font-medium rounded-xl border border-gray-200 dark:border-base-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:border-blue-200 dark:hover:border-blue-800 hover:text-blue-600 dark:hover:text-blue-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed mb-2 shadow-sm"
                                                    onClick={handleImportDb}
                                                    disabled={status === 'loading' || status === 'success'}
                                                >
                                                    <CheckCircle2 className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    {t('accounts.add.import.btn_db')}
                                                </button>
                                                <button
                                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-base-200 text-gray-700 dark:text-gray-300 font-medium rounded-xl border border-gray-200 dark:border-base-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:border-indigo-200 dark:hover:border-indigo-800 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                                    onClick={handleImportCustomDb}
                                                    disabled={status === 'loading' || status === 'success'}
                                                >
                                                    <Database className="w-4 h-4" />
                                                    {t('accounts.add.import.btn_custom_db') || 'Custom DB (state.vscdb)'}
                                                </button>
                                            </div>

                                            <div className="divider text-xs text-gray-300 dark:text-gray-600">{t('accounts.add.import.or')}</div>

                                            <div className="space-y-2">
                                                <h4 className="font-semibold flex items-center gap-2 text-gray-800 dark:text-gray-200">
                                                    <FileClock className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                                                    {t('accounts.add.import.scheme_b')}
                                                </h4>
                                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                                    {t('accounts.add.import.scheme_b_desc')}
                                                </p>
                                                <button
                                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-base-200 text-gray-700 dark:text-gray-300 font-medium rounded-xl border border-gray-200 dark:border-base-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:border-emerald-200 dark:hover:border-emerald-800 hover:text-emerald-600 dark:hover:text-emerald-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                                    onClick={handleImportV1}
                                                    disabled={status === 'loading' || status === 'success'}
                                                >
                                                    <FileClock className="w-4 h-4" />
                                                    {t('accounts.add.import.btn_v1')}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}

                            {selectedProvider === 'codex' && (
                                <>
                                    {/* Codex OAuth */}
                                    {codexActiveTab === 'oauth' && (
                                        <div className="space-y-6 py-4">
                                            <div className="text-center space-y-3">
                                                <div className="bg-green-50 dark:bg-green-900/20 p-6 rounded-full w-20 h-20 mx-auto flex items-center justify-center">
                                                    <Globe className="w-10 h-10 text-green-500" />
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-medium text-gray-900 dark:text-gray-100">{t('accounts.add.codex_oauth')}</h4>
                                                    <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">
                                                        {t('accounts.add.codex_oauth_desc')}
                                                    </p>
                                                </div>
                                            </div>
                                            <button
                                                className="w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-xl shadow-lg shadow-green-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                                                onClick={handleCodexOAuth}
                                                disabled={status === 'loading' || status === 'success'}
                                            >
                                                {status === 'loading' ? t('accounts.add.oauth.btn_waiting') : t('accounts.add.codex_oauth')}
                                            </button>
                                        </div>
                                    )}

                                    {/* Codex Manual Token */}
                                    {codexActiveTab === 'token' && (
                                        <div className="space-y-4 py-2">
                                            <div className="bg-gray-50 dark:bg-base-200 p-4 rounded-lg border border-gray-200 dark:border-base-300">
                                                <div className="flex justify-between items-center mb-2">
                                                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('accounts.add.codex_token')}</span>
                                                </div>
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                                                    {t('accounts.add.codex_token_desc')}
                                                </p>
                                                <input
                                                    type="text"
                                                    className="w-full text-xs py-2 px-3 bg-white dark:bg-base-100 border border-gray-200 dark:border-base-300 rounded-xl focus:ring-2 focus:ring-green-500/20 focus:border-green-500 outline-none transition-all placeholder:text-gray-400 font-mono mb-2"
                                                    placeholder={t('accounts.add.codex_token_placeholder')}
                                                    value={codexToken}
                                                    onChange={(e) => setCodexToken(e.target.value)}
                                                    disabled={status === 'loading' || status === 'success'}
                                                />
                                                <input
                                                    type="text"
                                                    className="w-full text-xs py-2 px-3 bg-white dark:bg-base-100 border border-gray-200 dark:border-base-300 rounded-xl focus:ring-2 focus:ring-green-500/20 focus:border-green-500 outline-none transition-all placeholder:text-gray-400 font-mono"
                                                    placeholder={t('accounts.add.codex_refresh_token_placeholder')}
                                                    value={codexRefreshToken}
                                                    onChange={(e) => setCodexRefreshToken(e.target.value)}
                                                    disabled={status === 'loading' || status === 'success'}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {/* Codex Import from File */}
                                    {codexActiveTab === 'import' && (
                                        <div className="space-y-6 py-4">
                                            <div className="text-center space-y-3">
                                                <div className="bg-green-50 dark:bg-green-900/20 p-6 rounded-full w-20 h-20 mx-auto flex items-center justify-center">
                                                    <Database className="w-10 h-10 text-green-500" />
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-medium text-gray-900 dark:text-gray-100">{t('accounts.add.codex_import')}</h4>
                                                    <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">
                                                        {t('accounts.add.codex_import_desc')}
                                                    </p>
                                                </div>
                                            </div>
                                            <button
                                                className="w-full px-4 py-3 bg-gray-50 dark:bg-base-200 text-gray-700 dark:text-gray-300 font-medium rounded-xl border border-gray-200 dark:border-base-300 hover:bg-green-50 dark:hover:bg-green-900/20 hover:border-green-200 dark:hover:border-green-800 hover:text-green-600 dark:hover:text-green-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                                onClick={handleCodexImport}
                                                disabled={status === 'loading' || status === 'success'}
                                            >
                                                <Database className="w-4 h-4" />
                                                {t('accounts.add.codex_import_btn')}
                                            </button>
                                            <button
                                                className="w-full px-4 py-3 bg-gray-50 dark:bg-base-200 text-gray-700 dark:text-gray-300 font-medium rounded-xl border border-gray-200 dark:border-base-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:border-emerald-200 dark:hover:border-emerald-800 hover:text-emerald-600 dark:hover:text-emerald-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                                onClick={handleCodexBatchImport}
                                                disabled={status === 'loading' || status === 'success'}
                                            >
                                                <FileClock className="w-4 h-4" />
                                                {t('accounts.add.codex_batch_import_btn')}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="flex gap-3 w-full mt-6">
                            <button
                                className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-base-200 text-gray-700 dark:text-gray-300 font-medium rounded-xl hover:bg-gray-200 dark:hover:bg-base-300 transition-colors focus:outline-none focus:ring-2 focus:ring-200 dark:focus:ring-base-300"
                                onClick={async () => {
                                    if (status === 'loading' && activeTab === 'oauth') {
                                        await cancelOAuthLogin();
                                    }
                                    setIsOpen(false);
                                }}
                                disabled={status === 'success'} // Only disable on success, allow cancel on loading
                            >
                                {t('accounts.add.btn_cancel')}
                            </button>
                            {selectedProvider === 'google' && activeTab === 'token' && (
                                <button
                                    className="flex-1 px-4 py-2.5 text-white font-medium rounded-xl shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 bg-blue-500 hover:bg-blue-600 focus:ring-blue-500 shadow-blue-100 dark:shadow-blue-900/30 flex justify-center items-center gap-2"
                                    onClick={handleSubmit}
                                    disabled={status === 'loading' || status === 'success'}
                                >
                                    {status === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                    {t('accounts.add.btn_confirm')}
                                </button>
                            )}
                            {selectedProvider === 'codex' && codexActiveTab === 'token' && (
                                <button
                                    className="flex-1 px-4 py-2.5 text-white font-medium rounded-xl shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 bg-green-500 hover:bg-green-600 focus:ring-green-500 shadow-green-100 dark:shadow-green-900/30 flex justify-center items-center gap-2"
                                    onClick={handleCodexTokenSubmit}
                                    disabled={status === 'loading' || status === 'success'}
                                >
                                    {status === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                    {t('accounts.add.btn_confirm')}
                                </button>
                            )}
                        </div>
                    </div>
                </div >,
                document.body
            )
            }
        </>
    );
}

export default AddAccountDialog;
