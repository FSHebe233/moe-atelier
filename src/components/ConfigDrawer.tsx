import React from 'react';
import {
  AutoComplete,
  Button,
  Collapse,
  Divider,
  Drawer,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
  Row,
  Col,
} from 'antd';
import {
  ApiFilled,
  ExperimentFilled,
  KeyOutlined,
  ReloadOutlined,
  SafetyCertificateFilled,
  SettingFilled,
  ThunderboltFilled,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SaveOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { Popconfirm } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import type { FormInstance } from 'antd/es/form';
import type { AppConfig } from '../types/app';
import type { ApiFormat } from '../utils/apiUrl';
import { API_VERSION_OPTIONS, DEFAULT_API_BASES } from '../utils/apiUrl';
import { ASPECT_RATIO_OPTIONS, IMAGE_SIZE_OPTIONS, SAFETY_OPTIONS } from '../app/constants';
import LazySliderInput from '../shared/ui/LazySliderInput';

const { Text } = Typography;

interface ConfigDrawerProps {
  visible: boolean;
  config: AppConfig;
  form: FormInstance<AppConfig>;
  onClose: () => void;
  onConfigChange: (changedValues: Partial<AppConfig>, values: AppConfig) => void;
  models: { label: string; value: string }[];
  loadingModels: boolean;
  fetchModels: () => void;
  backendSwitchChecked: boolean;
  backendSyncing: boolean;
  backendAuthLoading: boolean;
  backendMode: boolean;
  backendAuthPending: boolean;
  backendPassword: string;
  onBackendPasswordChange: (value: string) => void;
  onBackendEnable: () => void;
  onBackendDisable: () => void;
  onBackendAuthCancel: () => void;
  onBackendAuthConfirm: () => void;
}

const ConfigDrawer: React.FC<ConfigDrawerProps> = ({
  visible,
  config,
  form,
  onClose,
  onConfigChange,
  models,
  loadingModels,
  fetchModels,
  backendSwitchChecked,
  backendSyncing,
  backendAuthLoading,
  backendMode,
  backendAuthPending,
  backendPassword,
  onBackendPasswordChange,
  onBackendEnable,
  onBackendDisable,
  onBackendAuthCancel,
  onBackendAuthConfirm,
}) => {
  const [editingProfileId, setEditingProfileId] = React.useState<string | null>(null);
  const [editingProfileName, setEditingProfileName] = React.useState<string>('');

  const activeProfileId = config.activeApiProfileId || 'default';
  const profiles = config.apiProfiles || [];

  const handleAddProfile = () => {
    const { apiProfiles, activeApiProfileId, stream, enableCollection, ...profileFields } = config as any;
    const newProfile = {
      ...profileFields,
      id: uuidv4(),
      name: `新配置 ${profiles.length + 1}`
    };
    const newProfiles = [...profiles, newProfile];
    onConfigChange({ apiProfiles: newProfiles, activeApiProfileId: newProfile.id }, { ...config, apiProfiles: newProfiles, activeApiProfileId: newProfile.id });
  };

  const handleDeleteProfile = () => {
    if (profiles.length <= 1) return;
    const newProfiles = profiles.filter(p => p.id !== activeProfileId);
    const newActiveId = newProfiles[0].id;
    onConfigChange({ apiProfiles: newProfiles, activeApiProfileId: newActiveId }, { ...config, apiProfiles: newProfiles, activeApiProfileId: newActiveId });
  };

  const handleStartRename = () => {
    setEditingProfileId(activeProfileId);
    const currentProfile = profiles.find(p => p.id === activeProfileId);
    setEditingProfileName(currentProfile?.name || '');
  };

  const handleSaveRename = () => {
    if (!editingProfileName.trim()) {
      setEditingProfileId(null);
      return;
    }
    const newProfiles = profiles.map(p => p.id === activeProfileId ? { ...p, name: editingProfileName.trim() } : p);
    onConfigChange({ apiProfiles: newProfiles }, { ...config, apiProfiles: newProfiles });
    setEditingProfileId(null);
  };

  const handleProfileChange = (value: string) => {
    onConfigChange({ activeApiProfileId: value }, { ...config, activeApiProfileId: value });
  };

  return (
  <Drawer
    title={
      <Space>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: 'var(--c-primary-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FF9EB5',
          }}
        >
          <SettingFilled />
        </div>
        <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--c-text-main)' }}>系统配置</span>
      </Space>
    }
    placement="right"
    onClose={onClose}
    open={visible}
    width={400}
    styles={{ body: { padding: 24 } }}
  >
    <Form layout="vertical" initialValues={config} onValuesChange={onConfigChange} form={form}>
      
      <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>API 配置档</span>} style={{ marginBottom: 24 }}>
        {editingProfileId === activeProfileId ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input 
              value={editingProfileName} 
              onChange={e => setEditingProfileName(e.target.value)} 
              onPressEnter={handleSaveRename}
              style={{ flex: 1 }}
              autoFocus
            />
            <Button icon={<SaveOutlined />} type="primary" onClick={handleSaveRename} />
            <Button icon={<CloseOutlined />} onClick={() => setEditingProfileId(null)} />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select
              value={activeProfileId}
              onChange={handleProfileChange}
              options={profiles.map(p => ({ label: p.name, value: p.id }))}
              style={{ flex: 1 }}
            />
            <Tooltip title="重命名当前配置">
              <Button icon={<EditOutlined />} onClick={handleStartRename} />
            </Tooltip>
            <Tooltip title="添加新配置">
              <Button icon={<PlusOutlined />} onClick={handleAddProfile} />
            </Tooltip>
            <Tooltip title="删除当前配置">
              <Popconfirm title="确定删除当前配置档？" onConfirm={handleDeleteProfile} disabled={profiles.length <= 1}>
                <Button icon={<DeleteOutlined />} danger disabled={profiles.length <= 1} />
              </Popconfirm>
            </Tooltip>
          </div>
        )}
      </Form.Item>

      <div style={{ borderBottom: '1px solid #f0f0f0', marginBottom: 24 }} />

      <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>API 格式</span>}>
        <Form.Item name="apiFormat" noStyle>
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="openai">OpenAI</Radio.Button>
            <Radio.Button value="gemini">Gemini</Radio.Button>
            <Radio.Button value="vertex">Vertex</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form.Item>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}>
        {({ getFieldValue }) => {
          const apiFormat = getFieldValue('apiFormat') || 'openai';
          if (apiFormat === 'openai') {
            return null;
          }
          return (
            <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>API 版本</span>}>
              <Form.Item name="apiVersion" noStyle>
                <AutoComplete
                  options={API_VERSION_OPTIONS.map((version) => ({ value: version }))}
                  filterOption={(inputValue, option) =>
                    option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                  }
                >
                  <Input size="large" placeholder="v1beta" prefix={<ApiFilled style={{ color: '#FF9EB5' }} />} />
                </AutoComplete>
              </Form.Item>
            </Form.Item>
          );
        }}
      </Form.Item>

      <Form.Item
        label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>API 接口地址</span>}
        shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}
      >
        {({ getFieldValue }) => {
          const format = (getFieldValue('apiFormat') || 'openai') as ApiFormat;
          const placeholder = DEFAULT_API_BASES[format] || DEFAULT_API_BASES.openai;
          return (
            <Form.Item name="apiUrl" noStyle>
              <Input size="large" placeholder={placeholder} prefix={<ApiFilled style={{ color: '#FF9EB5' }} />} />
            </Form.Item>
          );
        }}
      </Form.Item>

      <Form.Item name="apiKey" label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>API 密钥</span>}>
        <Input.Password size="large" placeholder="sk-..." prefix={<SafetyCertificateFilled style={{ color: '#FF9EB5' }} />} />
      </Form.Item>

      <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>模型名称</span>} style={{ marginBottom: 48 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Form.Item name="model" noStyle>
              <AutoComplete
                className="model-autocomplete"
                options={models}
                filterOption={(inputValue, option) =>
                  option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                }
                dropdownMatchSelectWidth={false}
                dropdownStyle={{ minWidth: 300 }}
              >
                <Input size="large" placeholder="请输入模型名称" prefix={<ExperimentFilled style={{ color: '#FF9EB5' }} />} />
              </AutoComplete>
            </Form.Item>
          </div>
          <Tooltip title="获取模型列表">
            <Button
              className="model-refresh-btn"
              icon={<ReloadOutlined spin={loadingModels} />}
              onClick={fetchModels}
              size="large"
              shape="circle"
            />
          </Tooltip>
        </div>
      </Form.Item>

      <div
        style={{
          background: 'var(--c-bg)',
          padding: '16px',
          borderRadius: 16,
          marginBottom: 24,
          border: '1px solid var(--c-primary-light)',
        }}
      >
        <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>流式传输</span>} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              启用实时生成进度更新
            </Text>
            <Form.Item name="stream" valuePropName="checked" noStyle>
              <Switch />
            </Form.Item>
          </div>
        </Form.Item>

        <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>图片收纳</span>} style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              自动收纳生成的图片和提示词
            </Text>
            <Form.Item name="enableCollection" valuePropName="checked" noStyle>
              <Switch />
            </Form.Item>
          </div>
        </Form.Item>
      </div>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}>
        {({ getFieldValue }) => {
          const apiFormat = getFieldValue('apiFormat') || 'openai';
          if (apiFormat === 'openai') {
            return null;
          }
          return (
            <Collapse
              ghost
              items={[
                {
                  key: '1',
                  label: <span style={{ fontWeight: 700, color: 'var(--c-warning-dark)' }}>高级设置（Gemini / Vertex）</span>,
                  style: { background: 'var(--c-bg)', borderRadius: 16, border: '1px dashed var(--c-warning-dark)', marginBottom: 24 },
                  children: (
                    <div>
                      <Text style={{ fontWeight: 600, color: 'var(--c-warning-dark)', display: 'block', marginBottom: 8 }}>思考配置</Text>
                      <Form.Item
                        name="includeThoughts"
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>启用思考</span>}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="thinkingBudget"
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>思考预算 (Tokens)</span>}
                        style={{ marginBottom: 0 }}
                      >
                        <LazySliderInput min={0} max={8192} step={128} />
                      </Form.Item>

                      <Divider style={{ margin: '12px 0' }} />

                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>图像参数</Text>
                      <Form.Item
                        name="includeImageConfig"
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>启用图像配置</span>}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name={['imageConfig', 'imageSize']}
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>分辨率</span>}
                        style={{ marginBottom: 8 }}
                      >
                        <Radio.Group optionType="button" buttonStyle="solid">
                          {IMAGE_SIZE_OPTIONS.map((size) => (
                            <Radio.Button key={size} value={size}>
                              {size}
                            </Radio.Button>
                          ))}
                        </Radio.Group>
                      </Form.Item>
                      <Form.Item
                        name={['imageConfig', 'aspectRatio']}
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>比例</span>}
                        style={{ marginBottom: 8 }}
                      >
                        <Select options={ASPECT_RATIO_OPTIONS.map((value) => ({ value, label: value }))} />
                      </Form.Item>

                      <Form.Item
                        name="webpQuality"
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>WebP 质量</span>}
                        style={{ marginBottom: 8 }}
                      >
                        <LazySliderInput min={50} max={100} step={1} />
                      </Form.Item>

                      <Form.Item
                        name="useResponseModalities"
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>响应模态</span>}
                        valuePropName="checked"
                        extra="TEXT + IMAGE（官方端点可用）"
                        style={{ marginBottom: 0 }}
                      >
                        <Switch />
                      </Form.Item>

                      <Divider style={{ margin: '12px 0' }} />

                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>安全设置</Text>
                      <Form.Item
                        name="includeSafetySettings"
                        label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>启用安全设置</span>}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Switch />
                      </Form.Item>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_HARASSMENT']}
                            label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>骚扰内容</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_HATE_SPEECH']}
                            label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>仇恨言论</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_SEXUALLY_EXPLICIT']}
                            label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>色情内容</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_DANGEROUS_CONTENT']}
                            label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>危险内容</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_CIVIC_INTEGRITY']}
                            label={<span style={{ fontWeight: 600, color: 'var(--c-text-main)' }}>公民诚信</span>}
                            style={{ marginBottom: 0 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                      </Row>

                      <Divider style={{ margin: '12px 0' }} />

                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>自定义 JSON</Text>
                      <Form.Item
                        name="customJson"
                        extra="将合并到请求体中（仅 Gemini / Vertex）"
                        style={{ marginBottom: 0 }}
                      >
                        <Input.TextArea rows={4} placeholder='{"generationConfig": {"topK": 40}}' />
                      </Form.Item>
                    </div>
                  ),
                },
              ]}
            />
          );
        }}
      </Form.Item>

      <div
        style={{
          background: 'var(--c-bg)',
          padding: '16px',
          borderRadius: 16,
          marginBottom: 24,
          border: '1px dashed var(--c-info)',
        }}
      >
        <Form.Item label={<span style={{ fontWeight: 700, color: 'var(--c-text-main)' }}>后端模式</span>} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <Text type="secondary" style={{ fontSize: 13, flex: 1 }}>
              开启后将配置与任务缓存到服务器，支持多端同步
            </Text>
            <Switch
              checked={backendSwitchChecked}
              loading={backendSyncing}
              disabled={backendAuthLoading}
              onChange={(checked) => {
                if (checked) {
                  if (!backendMode) {
                    onBackendEnable();
                  }
                } else {
                  if (backendMode) {
                    onBackendDisable();
                  } else {
                    onBackendAuthCancel();
                  }
                }
              }}
            />
          </div>
        </Form.Item>
        <div style={{ marginTop: 16 }}>
          <Text type="secondary" style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5, display: 'block' }}>
            需要在服务端 .env 中设置 BACKEND_PASSWORD。开启后生图请求将由服务器执行并自动缓存。
          </Text>
        </div>
        <div className={`password-collapse-container ${backendAuthPending && !backendMode ? 'open' : ''}`}>
          <div className="password-content-wrapper">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12, color: '#6B7280' }}>
                请输入 .env 中配置的 BACKEND_PASSWORD。
              </Text>
              <Input.Password
                size="large"
                value={backendPassword}
                placeholder="后端密码"
                prefix={<KeyOutlined style={{ color: '#FF9EB5', fontSize: 18 }} />}
                onChange={(e) => onBackendPasswordChange(e.target.value)}
                onPressEnter={() => void onBackendAuthConfirm()}
              />
              <Space size={8}>
                <Button size="small" onClick={() => void onBackendAuthConfirm()} loading={backendAuthLoading} type="primary">
                  验证
                </Button>
                <Button size="small" type="text" onClick={onBackendAuthCancel}>
                  取消
                </Button>
              </Space>
            </Space>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 24, padding: 16, background: 'var(--c-bg)', borderRadius: 16, border: '1px dashed var(--c-warning-dark)' }}>
        <Space align="start">
          <ThunderboltFilled style={{ color: 'var(--c-warning-dark)', marginTop: 4, fontSize: 16 }} />
          <Text type="secondary" style={{ fontSize: 13, color: 'var(--c-text-main)', lineHeight: 1.5 }}>
            设置将自动应用于所有活动任务窗口。请确保您的 API 密钥有足够的配额。
          </Text>
        </Space>
      </div>
    </Form>
  </Drawer>
  );
};

export default ConfigDrawer;
