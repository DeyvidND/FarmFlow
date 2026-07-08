import { OrdersController } from './orders.controller';

function ctrl() {
  const service = {
    reschedulable: jest.fn().mockResolvedValue([{ id: 'o1' }]),
    rescheduleOrders: jest.fn().mockResolvedValue({ moved: 2, toDate: '2026-07-10' }),
  };
  return { c: new OrdersController(service as any), service };
}

describe('OrdersController reschedule routes', () => {
  it('GET /orders/reschedulable delegates with the tenant id', async () => {
    const { c, service } = ctrl();
    await c.reschedulable('t1');
    expect(service.reschedulable).toHaveBeenCalledWith('t1');
  });

  it('POST /orders/reschedule delegates the dto', async () => {
    const { c, service } = ctrl();
    const dto = { orderIds: ['a'], toDate: '2026-07-10' };
    const res = await c.reschedule('t1', dto as any);
    expect(service.rescheduleOrders).toHaveBeenCalledWith('t1', dto);
    expect(res).toEqual({ moved: 2, toDate: '2026-07-10' });
  });
});
