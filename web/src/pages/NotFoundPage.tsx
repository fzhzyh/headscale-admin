import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { CompassOutlined } from '@ant-design/icons';

export default function NotFoundPage(): React.ReactElement {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-500">
        <CompassOutlined style={{ fontSize: 28 }} />
      </div>
      <div className="text-[40px] font-semibold leading-none tracking-tight text-ink-300">404</div>
      <div className="mt-3 text-[14px] font-medium text-ink-700">页面不存在</div>
      <div className="mt-1 text-[12.5px] text-ink-400">
        该地址可能已变更，或你没有访问该功能的权限。
      </div>
      <Button type="primary" className="mt-5" onClick={() => navigate('/dashboard')}>
        返回控制台
      </Button>
    </div>
  );
}
