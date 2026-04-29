import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { TimeOffModule } from '../src/time-off/time-off.module';
import { Balance } from '../src/time-off/entities/balance.entity';
import { TimeOffRequest, RequestStatus } from '../src/time-off/entities/time-off-request.entity';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

describe('TimeOffService (Integration & E2E Suite)', () => {
  let app: INestApplication;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [Balance, TimeOffRequest],
          synchronize: true, 
        }),
        TimeOffModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    
    balanceRepo = moduleFixture.get('BalanceRepository');
    requestRepo = moduleFixture.get('TimeOffRequestRepository');
  });

  afterAll(async () => {
    const dataSource = app.get(DataSource);
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
    await app.close();
  });

  beforeEach(async () => {
    
    await requestRepo.clear();
    await balanceRepo.clear();

    await balanceRepo.save({
      employeeId: 'EMP-1',
      locationId: 'LOC-1',
      totalDays: 10,
      reservedDays: 0,
      version: 1,
    });
  });

  afterEach(() => {
    jest.resetAllMocks(); 
  });


  
  it('Integration: Should create request and manage statuses fully', async () => {
    
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'APPROVED', hcmReferenceId: 'HCM-123' })
    });

    
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({
        employeeId: 'EMP-1',
        locationId: 'LOC-1',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3
      })
      .expect(201);

    expect(res.body.status).toBe(RequestStatus.PENDING);
    expect(res.body.daysRequested).toBe(3);

    
    await new Promise(resolve => setTimeout(resolve, 100));

    
    const finalBalance = await balanceRepo.findOneBy({ employeeId: 'EMP-1' });
    expect(finalBalance.totalDays).toBe(7);
    expect(finalBalance.reservedDays).toBe(0);

    
    const finalRequest = await requestRepo.findOneBy({ id: res.body.id });
    expect(finalRequest.status).toBe(RequestStatus.APPROVED);
    expect(finalRequest.hcmReferenceId).toBe('HCM-123');
  });


  
  it('Race Condition / Concurrency Validation: Should never yield negative balance', async () => {
    
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'APPROVED', hcmReferenceId: 'HCM-R' })
    });

    
    const promises = Array(5).fill(null).map(() => 
      request(app.getHttpServer())
        .post('/time-off/requests')
        .send({
          employeeId: 'EMP-1',
          locationId: 'LOC-1',
          startDate: '2026-06-01',
          endDate: '2026-06-03',
          daysRequested: 3
        })
    );

    const results = await Promise.all(promises);
    
    
    const successRes = results.filter(r => r.status === 201);
    const failRes = results.filter(r => r.status === 400 || r.status === 500);

    
    
    expect(successRes.length).toBeLessThanOrEqual(3);
    
    
    const finalBal = await balanceRepo.findOneBy({ employeeId: 'EMP-1' });
    const actualAvailable = finalBal.totalDays - finalBal.reservedDays;

    expect(actualAvailable).toBeGreaterThanOrEqual(0);
    
    expect(actualAvailable).toBeLessThanOrEqual(10); 
  });


  
  it('Sync Test (Self-Healing): Should recover when HCM balance differs from local balance', async () => {
     
     
     
     global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ totalDays: 20 })
    });

    
    const res = await request(app.getHttpServer())
      .post('/time-off/sync/batch')
      .send({ employeeId: 'EMP-1', locationId: 'LOC-1' })
      .expect(201);

    expect(res.body.updated).toBeGreaterThan(0);
    const detail = res.body.details.find((d: any) => d.employeeId === 'EMP-1');
    expect(detail.newTotal).toBe(20);

    
    const balTest = await request(app.getHttpServer())
      .get('/time-off/balances?employeeId=EMP-1&locationId=LOC-1')
      .expect(200);
    
    expect(balTest.body.total).toBe(20);
    expect(balTest.body.actualAvailable).toBe(20);
  });

  
  it('HCM Latency: System should not block if HCM takes seconds to respond', async () => {
    
    global.fetch = jest.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 2000)); 
      return {
        ok: true,
        json: jest.fn().mockResolvedValue({ status: 'APPROVED', hcmReferenceId: 'HCM-LATENCY' })
      };
    });

    const start = Date.now();

    
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employeeId: 'EMP-1', locationId: 'LOC-1', startDate: '2026-05-01', endDate: '2026-05-03', daysRequested: 3 })
      .expect(201);
    
    const duration = Date.now() - start;

    
    expect(duration).toBeLessThan(500); 
    expect(res.body.status).toBe(RequestStatus.PENDING);
  });

  
  it('Partial Success: Should handle a mixed batch where some HCM endpoints fail and some succeed', async () => {
    
    await balanceRepo.clear();
    const seeds = Array.from({ length: 10 }).map((_, i) => ({
      employeeId: `EMP-BATCH-${i}`,
      locationId: 'LOC-BATCH',
      totalDays: 10,
      reservedDays: 0,
      version: 1,
    }));
    await balanceRepo.save(seeds);

    
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const match = url.match(/employeeId=EMP-BATCH-(\d)/);
      if (!match) throw new Error('HCM Network Failure');
      const index = parseInt(match[1]);
      
      if (index < 5) {
        return { ok: true, json: async () => ({ totalDays: 20 }) };
      } else {
        throw new Error('HCM Network Failure');
      }
    });

    
    const res = await request(app.getHttpServer())
      .post('/time-off/sync/batch')
      .send({ locationId: 'LOC-BATCH' })
      .expect(201);

    
    expect(res.body.updated).toBe(5);    
    expect(res.body.alreadyInSync).toBe(0);
    expect(res.body.details.filter((d: any) => d.status === 'ERROR').length).toBe(5); 

    const successEmps = await balanceRepo.find({ where: { employeeId: 'EMP-BATCH-0' } });
    const failEmps = await balanceRepo.find({ where: { employeeId: 'EMP-BATCH-9' } });

    expect(successEmps[0].totalDays).toBe(20); 
    expect(failEmps[0].totalDays).toBe(10);    
  });

  
  it('Negative Balance Prevention: Must reject 400 if reserved days block the new request', async () => {
    
    await balanceRepo.update({ employeeId: 'EMP-1' }, { reservedDays: 9 });

    
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .send({ employeeId: 'EMP-1', locationId: 'LOC-1', startDate: '2026-05-01', endDate: '2026-05-02', daysRequested: 2 });

    
    expect(res.status).toBe(400);
    
    expect(res.body.message).toBeDefined();
    
    
    const balTest = await request(app.getHttpServer())
      .get('/time-off/balances?employeeId=EMP-1&locationId=LOC-1')
      .expect(200);
    
    expect(balTest.body.total).toBe(10);
    expect(balTest.body.reserved).toBe(9);
    expect(balTest.body.actualAvailable).toBe(1);
  });
});
