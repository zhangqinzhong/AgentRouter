import React from 'react';
import { createRoot } from 'react-dom/client';
import { DataSourcesSettingsPage } from '../../../packages/ui/src/pages/home/components/data-sources';
import { AppI18nContext, appCopy } from '../../../packages/ui/src/pages/home/shared/i18n';
createRoot(document.getElementById('root')).render(<AppI18nContext.Provider value={appCopy.zh}><main className="mx-auto max-w-[720px] p-6"><DataSourcesSettingsPage configDir="/home/test/.agentrouter" profiles={[{ id: "default-codex", name: "Codex Personal" }, { id: "company", name: "Codex Company" }]} /></main></AppI18nContext.Provider>);
