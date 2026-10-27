import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Spin } from 'antd';

import { useAuth } from './store/auth';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import NodesPage from './pages/NodesPage';
import RoutesPage from './pages/RoutesPage';
import TopologyPage from './pages/TopologyPage';
import UsersPage from './pages/UsersPage';
import KeysPage from './pages/KeysPage';
import PanelUsersPage from './pages/PanelUsersPage';
import SettingsPage from './pages/SettingsPage';
import ConnectPage from './pages/ConnectPage';
import AclPage from './pages/AclPage';
import AuditPage from './pages/AuditPage';
import NotFoundPage from './pages/NotFoundPage';

function RequireAuth({ children }: { children: React.ReactNode }): React.ReactElement {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spin size="large" tip="正在校验会话…" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

export default function App(): React.ReactElement {
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="topology" element={<TopologyPage />} />
        <Route path="routes" element={<RoutesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="panel-users" element={<PanelUsersPage />} />
        <Route path="acl" element={<AclPage />} />
        <Route path="connect" element={<ConnectPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
