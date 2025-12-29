// ohif/app-config.js
(function () {
  const params = new URLSearchParams(window.location.search);
  const defaultRoot = 'http://localhost:8043/dicom-web';

  const getStoredRoot = () => {
    try {
      return window.localStorage.getItem('dicomwebRoot') || '';
    } catch (_) {
      return '';
    }
  };

  const persistRoot = (value) => {
    try {
      window.localStorage.setItem('dicomwebRoot', value);
    } catch (_) {
      /* no-op */
    }
  };

  const sanitizeRoot = (raw) => {
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.origin);
      const normalized = url.href.replace(/\/$/, '');
      return normalized;
    } catch (_) {
      return '';
    }
  };

  // ★ 追加: Study List が 0 件になる問題への対策
  // 以前のフィルター設定が残っていると表示されない場合があるため、
  // ページ読み込み時にフィルター関連の localStorage をクリアする
  try {
    const keysToRemove = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.includes('filter') || key.includes('Sort') || key.includes('studyList'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => window.localStorage.removeItem(k));
    console.log('Cleared OHIF filters:', keysToRemove);
  } catch (e) {
    console.warn('Failed to clear OHIF filters', e);
  }

  let dicomwebRoot = sanitizeRoot(params.get('dicomweb'));
  if (dicomwebRoot) {
    persistRoot(dicomwebRoot);
  } else {
    dicomwebRoot = sanitizeRoot(getStoredRoot()) || defaultRoot;
  }

  const friendlyName = params.get('dicomwebName') || 'Requester (Orthanc 8043)';
  const basicUser = params.get('dicomwebUser') || 'orthanc';
  const basicPass = params.get('dicomwebPass') || 'orthanc';
  const requestOptions = {
    auth: {
      username: basicUser,
      password: basicPass,
    },
  };

  window.config = {
    routerBasename: '/',
    showStudyList: true,
    extensions: [],   // 必須ではないが空配列を入れておく
    modes: [],        // 同上
    dataSources: [
      {
        // ★ 公式ドキュメント推奨の名前空間
        namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
        sourceName: 'dicomweb',
        configuration: {
          friendlyName,
          name: 'ORTHANC',
          qidoRoot:    dicomwebRoot,
          wadoRoot:    dicomwebRoot,
          wadoUriRoot: dicomwebRoot,
          qidoSupportsIncludeField: true,
          imageRendering: 'wadors',
          thumbnailRendering: 'wadors',
          enableStudyLazyLoad: true,
          supportsFuzzyMatching: true,
          supportsWildcard: true,
          requestOptions,
        },
      },
    ],
    defaultDataSourceName: 'dicomweb',
  };
})();
