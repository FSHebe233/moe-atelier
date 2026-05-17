import React, { useState } from 'react';
import { Row, Col, Slider } from 'antd';

interface LazySliderProps {
  value?: number;
  onChange?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}

const LazySliderInput: React.FC<LazySliderProps> = ({
  value = 0,
  onChange,
  min,
  max,
  step = 1,
}) => {
  const [localValue, setLocalValue] = useState<number>(value);

  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleSliderChange = (val: number) => {
    setLocalValue(val);
  };

  const handleSliderAfterChange = (val: number) => {
    onChange?.(val);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === '') return;
    if (!/^\d+$/.test(val)) return;
    setLocalValue(Number(val));
  };

  const handleInputBlur = () => {
    let constrained = Math.max(min, Math.min(max, localValue));
    if (step) {
      constrained = Math.round(constrained / step) * step;
    }
    setLocalValue(constrained);
    onChange?.(constrained);
  };

  return (
    <Row gutter={12} align="middle">
      <Col span={16}>
        <Slider
          min={min}
          max={max}
          step={step}
          value={localValue}
          onChange={handleSliderChange}
          onAfterChange={handleSliderAfterChange}
        />
      </Col>
      <Col span={8}>
        <div
          style={{
            background: 'var(--c-bg-card)',
            padding: '2px 8px',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            height: 28,
            justifyContent: 'center',
          }}
        >
          <input
            type="number"
            value={localValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            style={{
              width: '100%',
              border: 'none',
              textAlign: 'center',
              color: 'var(--c-text-main)',
              fontWeight: 700,
              background: 'transparent',
              outline: 'none',
              fontSize: 12,
              padding: 0,
            }}
          />
        </div>
      </Col>
    </Row>
  );
};

export default LazySliderInput;
