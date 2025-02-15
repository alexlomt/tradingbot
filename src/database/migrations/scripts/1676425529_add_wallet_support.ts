import { Connection } from 'mongoose';

export const up = async (connection: Connection, session: any) => {
    await connection.createCollection('wallets', {
        validator: {
            $jsonSchema: {
                bsonType: 'object',
                required: ['userId', 'address', 'chain'],
                properties: {
                    userId: { bsonType: 'string' },
                    address: { bsonType: 'string' },
                    chain: { bsonType: 'string' },
                    balance: { bsonType: 'decimal' },
                    isActive: { bsonType: 'bool' },
                    lastSynced: { bsonType: 'date' }
                }
            }
        },
        session
    });

    await connection.collection('wallets').createIndexes([
        { key: { userId: 1 } },
        { key: { address: 1 }, unique: true },
        { key: { chain: 1, address: 1 } }
    ], { session });

    // Add wallet reference to users
    await connection.collection('users').updateMany(
        {},
        {
            $set: {
                wallets: [],
                preferredWallet: null
            }
        },
        { session }
    );
};

export const down = async (connection: Connection, session: any) => {
    await connection.dropCollection('wallets', { session });
    await connection.collection('users').updateMany(
        {},
        {
            $unset: {
                wallets: "",
                preferredWallet: ""
            }
        },
        { session }
    );
};
