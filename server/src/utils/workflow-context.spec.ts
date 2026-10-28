import { workflowCausation, inheritWorkflowCausation } from 'src/utils/workflow-context.js';
describe('workflow causation propagation', () => {
  it('keeps ordinary child job payloads unchanged', () => {
    const data = { id: 'asset' };
    expect(inheritWorkflowCausation(data)).toBe(data);
  });
  it('carries the immutable workflow chain into a durable child job', () => {
    const data = { id: 'asset' };
    const result = workflowCausation.run(['workflow:asset'], () => inheritWorkflowCausation(data));
    expect(result).toEqual({ id: 'asset', causation: ['workflow:asset'] });
    expect(data).not.toHaveProperty('causation');
  });
});

it('preserves the explicit child ancestry when admitting a nested workflow job',()=>{
  const result=workflowCausation.run(['chain:root','a:asset'],()=>inheritWorkflowCausation({id:'asset',causation:['chain:root','a:asset','b:asset']}));
  expect(result.causation).toEqual(['chain:root','a:asset','b:asset']);
});
