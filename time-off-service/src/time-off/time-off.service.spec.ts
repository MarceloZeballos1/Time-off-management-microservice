import { Test, TestingModule } from '@nestjs/testing';
import { TimeOffService } from './time-off.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest, RequestStatus } from './entities/time-off-request.entity';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';

describe('TimeOffService (Unit Tests)', () => {
  let service: TimeOffService;
  
  // Mocks
  const mockBalancesRepo: Partial<Record<keyof Repository<Balance>, jest.Mock>> = {
    findOneBy: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  
  const mockRequestsRepo: Partial<Record<keyof Repository<TimeOffRequest>, jest.Mock>> = {
    findOneBy: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
  };

  const mockQueryRunner: Partial<QueryRunner> = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as any,
  } as Partial<QueryRunner>;

  const mockDataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner as QueryRunner),
    transaction: jest.fn(),
  } as Partial<DataSource>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(Balance), useValue: mockBalancesRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestsRepo },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Balance Calculations', () => {
    it('should calculate actual available balance correctly', async () => {
      mockBalancesRepo.findOneBy!.mockResolvedValue({
        employeeId: '123',
        locationId: 'LOC-1',
        totalDays: 15,
        reservedDays: 5,
      });

      const result = await service.getBalances('123', 'LOC-1');

      expect(result.total).toBe(15);
      expect(result.reserved).toBe(5);
      expect(result.actualAvailable).toBe(10);
    });

    it('should throw BadRequestException if balance does not exist', async () => {
      mockBalancesRepo.findOneBy!.mockResolvedValue(null);
      await expect(service.getBalances('999', 'LOC-X')).rejects.toThrow(BadRequestException);
    });
  });

  describe('createRequest (Reservation-First Logic)', () => {
    it('should successfully reserve days and save a new PENDING request', async () => {
      const balance = {
        employeeId: '123',
        locationId: 'LOC-1',
        totalDays: 10,
        reservedDays: 2,
      };
      (mockQueryRunner.manager!.findOne as jest.Mock).mockResolvedValue(balance);
      (mockQueryRunner.manager!.create as jest.Mock).mockReturnValue({ id: 'req-1', status: 'PENDING' });
      
      jest.spyOn(service, 'syncRequest').mockResolvedValue(undefined);

      const request = await service.createRequest({
        employeeId: '123',
        locationId: 'LOC-1',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3,
      });

      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(balance.reservedDays).toBe(5); // 2 + 3
      expect(mockQueryRunner.manager!.save).toHaveBeenCalledWith(balance);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(request).toBeDefined();
    });

    it('should reject if days requested exceeds actual available', async () => {
      (mockQueryRunner.manager!.findOne as jest.Mock).mockResolvedValue({
        employeeId: '123',
        locationId: 'LOC-1',
        totalDays: 10,
        reservedDays: 9,
      });

      await expect(service.createRequest({
        employeeId: '123',
        locationId: 'LOC-1',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3,
      })).rejects.toThrow(BadRequestException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should return existing request if idempotencyKey matches', async () => {
      mockRequestsRepo.findOneBy!.mockResolvedValue({ id: 'existing-req' });
      
      const request = await service.createRequest({
        employeeId: '123',
        locationId: 'LOC-1',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3,
        idempotencyKey: 'key-123'
      });

      expect(request.id).toBe('existing-req');
      expect(mockQueryRunner.connect).not.toHaveBeenCalled();
    });
  });

  describe('syncRequest (Background Worker / HCM Integration)', () => {
    it('should approve and update balance on HCM APPROVED', async () => {
      const request = { id: 'req-1', employeeId: '123', status: RequestStatus.PENDING };
      mockRequestsRepo.findOneBy!.mockResolvedValue(request);

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'APPROVED', hcmReferenceId: 'ref-1' }),
      });

      (mockDataSource.transaction as jest.Mock).mockImplementation(async (cb: any) => {
        const manager = {
            findOne: jest.fn().mockResolvedValue({ employeeId: '123', totalDays: 10, reservedDays: 5 }),
            save: jest.fn(),
        };
        await cb(manager);
        expect(manager.save).toHaveBeenCalledTimes(2); // Balance and Request
      });

      await service.syncRequest('req-1', 'LOC-1', 2, 1);
    });

    it('should rollback reservation on HCM REJECTED', async () => {
      const request = { id: 'req-2', employeeId: '123', status: RequestStatus.PENDING };
      mockRequestsRepo.findOneBy!.mockResolvedValue(request);

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'REJECTED', reason: 'Insufficient in HCM' }),
      });

      (mockDataSource.transaction as jest.Mock).mockImplementation(async (cb: any) => {
        const manager = {
            findOne: jest.fn().mockResolvedValue({ employeeId: '123', totalDays: 10, reservedDays: 5 }),
            save: jest.fn(),
        };
        await cb(manager);
        expect(manager.save).toHaveBeenCalledTimes(2);
      });

      await service.syncRequest('req-2', 'LOC-1', 2, 1);
    });

    it('should retry on fetch failure', async () => {
      const request = { id: 'req-3', employeeId: '123', status: RequestStatus.PENDING };
      mockRequestsRepo.findOneBy!.mockResolvedValue(request);

      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      const loggerSpy = jest.spyOn(service['logger'], 'error');

      await service.syncRequest('req-3', 'LOC-1', 2, 1);
      
      expect(global.fetch).toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Max retries reached'));
    });
  });

  describe('reconcileBatch (Self-Healing)', () => {
    it('should update local balance if HCM has higher total', async () => {
      const localBalance = { employeeId: '123', locationId: 'LOC-1', totalDays: 10, reservedDays: 0 };
      mockBalancesRepo.find!.mockResolvedValue([localBalance]);
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ totalDays: 15 }),
      });

      const report = await service.reconcileBatch('LOC-1');
      expect(localBalance.totalDays).toBe(15);
      expect(mockBalancesRepo.save).toHaveBeenCalledWith(localBalance);
    });

    it('should handle unexistent locations gracefully', async () => {
      const localBalance = { employeeId: '123', locationId: 'LOC-1', totalDays: 10, reservedDays: 0 };
      mockBalancesRepo.find!.mockResolvedValue([localBalance]);
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
      });

      await service.reconcileBatch('LOC-1');
      expect(mockBalancesRepo.save).not.toHaveBeenCalled();
    });

    it('should push a new local balance if not present for a specific employee id sync', async () => {
      mockBalancesRepo.find!.mockResolvedValue([]);
      mockBalancesRepo.create!.mockReturnValue({ employeeId: '777', locationId: 'LOC-9', totalDays: 0, reservedDays: 0 });
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ totalDays: 5 }),
      });

      await service.reconcileBatch('LOC-9', '777');
      expect(mockBalancesRepo.create).toHaveBeenCalled();
      expect(mockBalancesRepo.save).toHaveBeenCalled();
    });
  });
});
