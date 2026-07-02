import React, { useState } from 'react';
import { Row, Col } from 'antd';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  defaultDropAnimationSideEffects,
  DropAnimation,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
  defaultAnimateLayoutChanges,
  AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ImageTask from './ImageTask';
import type { AppConfig, TaskConfig } from '../types/app';
import type { CollectionItem } from '../types/collection';
import { getTaskStorageKey } from '../app/storage';

interface TaskGridProps {
  tasks: TaskConfig[];
  config: AppConfig;
  backendMode: boolean;
  collectionRevision: number;
  onRemoveTask: (id: string) => void;
  onTaskNameChange: (id: string, name?: string) => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
  onCollect: (item: CollectionItem) => void;
  onReorder: (nextTasks: TaskConfig[]) => void;
}

interface SortableTaskItemProps {
  task: TaskConfig;
  config: AppConfig;
  backendMode: boolean;
  onRemove: (id: string) => void;
  onTaskNameChange: (id: string, name?: string) => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
  onCollect: (item: CollectionItem) => void;
  collectionRevision: number;
}

const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

const SortableTaskItem = ({
  task,
  config,
  backendMode,
  onRemove,
  onTaskNameChange,
  onStatsUpdate,
  onCollect,
  collectionRevision,
}: SortableTaskItemProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: task.id,
      animateLayoutChanges,
      transition: { duration: 240, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' },
    });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 999 : 'auto',
    opacity: isDragging ? 0 : 1,
  };

  return (
    <Col id={task.id} xs={24} sm={12} xl={8} ref={setNodeRef} style={style}>
      <div className="fade-in-up" style={{ height: '100%' }}>
        <ImageTask
          id={task.id}
          name={task.name}
          storageKey={getTaskStorageKey(task.id)}
          config={config}
          backendMode={backendMode}
          onRemove={() => onRemove(task.id)}
          onNameChange={onTaskNameChange}
          onStatsUpdate={onStatsUpdate}
          onCollect={onCollect}
          collectionRevision={collectionRevision}
          dragAttributes={attributes}
          dragListeners={listeners}
        />
      </div>
    </Col>
  );
};

const TaskGrid: React.FC<TaskGridProps> = ({
  tasks,
  config,
  backendMode,
  collectionRevision,
  onRemoveTask,
  onTaskNameChange,
  onStatsUpdate,
  onCollect,
  onReorder,
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeItemWidth, setActiveItemWidth] = useState<number | undefined>(undefined);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);
    const node = document.getElementById(active.id as string);
    if (node) {
      const innerContent = node.querySelector('.fade-in-up') as HTMLElement;
      if (innerContent) {
        setActiveItemWidth(innerContent.offsetWidth);
      } else {
        setActiveItemWidth(node.offsetWidth);
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveItemWidth(undefined);

    if (active.id !== over?.id) {
      const oldIndex = tasks.findIndex((item) => item.id === active.id);
      const newIndex = tasks.findIndex((item) => item.id === over?.id);
      const next = arrayMove(tasks, oldIndex, newIndex);
      onReorder(next);
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setActiveItemWidth(undefined);
  };

  const dropAnimation: DropAnimation = {
    duration: 300,
    easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    sideEffects: (args) => {
      const { dragOverlay } = args;
      const defaultFn = defaultDropAnimationSideEffects({
        styles: {
          active: {
            opacity: '0',
          },
        },
      });
      const cleanup = defaultFn(args);

      const inner = dragOverlay.node.querySelector('.drag-overlay-item');
      if (inner) {
        inner.animate([{ transform: 'scale(1.02)' }, { transform: 'scale(1)' }], {
          duration: 250,
          easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
          fill: 'forwards',
        });
      }
      return cleanup;
    },
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={tasks.map((t) => t.id)} strategy={rectSortingStrategy}>
        <Row gutter={[24, 24]}>
          {tasks.map((task) => (
            <SortableTaskItem
              key={task.id}
              task={task}
              config={config}
              backendMode={backendMode}
              onRemove={onRemoveTask}
              onTaskNameChange={onTaskNameChange}
              onStatsUpdate={onStatsUpdate}
              onCollect={onCollect}
              collectionRevision={collectionRevision}
            />
          ))}
        </Row>
      </SortableContext>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeId ? (
          <div
            className="drag-overlay-item"
            style={{
              cursor: 'grabbing',
              width: activeItemWidth,
            }}
          >
            <ImageTask
              id={activeId}
              name={tasks.find((task) => task.id === activeId)?.name}
              storageKey={getTaskStorageKey(activeId)}
              config={config}
              backendMode={backendMode}
              onRemove={() => onRemoveTask(activeId)}
              onNameChange={onTaskNameChange}
              onStatsUpdate={onStatsUpdate}
              collectionRevision={collectionRevision}
              dragAttributes={{}}
              dragListeners={{}}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

export default TaskGrid;
