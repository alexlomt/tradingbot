import { Connection } from 'mongoose';

export const up = async (connection: Connection, session: any) => {
    // Create users collection with indexes
    await connection.createCollection('users', {
        validator: {
            $jsonSchema: {
                bsonType: 'object',
                required: ['email', 'passwordHash'],
                properties: {
                    email: {
                        bsonType: 'string',
                        pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
                    },
                    passwordHash: { bsonType: 'string' },
                    isActive: { bsonType: 'bool' },
                    createdAt: { bsonType: 'date' }
                }
            }
        },
        session
    });

    await connection.collection('users').createIndexes([
        { key: { email: 1 }, unique: true },
        { key: { createdAt: 1 } }
    ], { session });

    // Create trades collection with indexes
    await connection.createCollection('trades', {
        validator: {
            $jsonSchema: {
                bsonType: 'object',
                required: ['userId', 'pair', 'amount'],
                properties: {
                    userId: { bsonType: 'string' },
                    pair: { bsonType: 'string' },
                    amount: { bsonType: 'decimal' },
                    price: { bsonType: 'decimal' },
                    type: { enum: ['MARKET', 'LIMIT'] },
                    status: { enum: ['PENDING', 'COMPLETED', 'FAILED'] },
                    createdAt: { bsonType: 'date' }
                }
            }
        },
        session
    });

    await connection.collection('trades').createIndexes([
        { key: { userId: 1, createdAt: -1 } },
        { key: { pair: 1, createdAt: -1 } },
        { key: { status: 1 } }
    ], { session });
};

export const down = async (connection: Connection, session: any) => {
    await connection.dropCollection('users', { session });
    await connection.dropCollection('trades', { session });
};
